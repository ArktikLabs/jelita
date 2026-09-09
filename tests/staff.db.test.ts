import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from './db'
import { STAFF_LIST, deactivateStaff, getStaff, listStaff, staffOf } from '../lib/staff'
import { setBaseSalary } from '../lib/payroll'
import { parseListQuery } from '../lib/list-query'

/**
 * Staff schema, the seeding trigger/backfill, the countResource('staff') SQL
 * facts, and the two ownerless-salon concurrency guards -- asserted against a
 * real Postgres, same reasoning as branch.db.test.ts and service.db.test.ts.
 * Screens, guards, form posts, provisioning (JSON API + Server Actions), the
 * bulk import (and its deterministic compensation test) and the
 * branch-status guard applied to staff assignment live in
 * tests/e2e/staff.spec.ts instead -- "deactivation frees a seat" and "the
 * owner itself consumes a seat" are PRODUCT claims proven there by a creation
 * that was refused actually succeeding afterwards, never by a count query
 * (tests/README.md). The branch_entitlement view's own lock ranking and
 * getBranchStatus's closed-beats-over_cap precedence are already proven in
 * tests/branch.db.test.ts -- this file only proves the trigger/backfill/
 * concurrency guards that are staff-specific.
 */
const pool = new Pool({ connectionString: TEST_DATABASE_URL })
const ORG = 'vt_staff_org'
const ORG2 = 'vt_staff_org2'
const ORG3 = 'vt_staff_org3'
const OWNERS_ORG = 'vt_staff_owners_org'

// users has no organization_id -- deleting the organizations above does not
// cascade to these rows (members and staff_profiles do, off the org), so
// they are cleaned up by id explicitly, both before and after.
const FIXTURE_USER_IDS = [
  'vt_staff_owner', 'vt_staff_dup', 'vt_staff_stylist', 'vt_staff_manajer',
  'vt_staff_count_owner', 'vt_staff_count_stylist', 'vt_staff_owner1', 'vt_staff_owner2',
]

beforeAll(async () => {
  await pool.query(`delete from organizations where id = any($1)`, [[ORG, ORG2, ORG3, OWNERS_ORG]])
  await pool.query(`delete from users where id = any($1)`, [FIXTURE_USER_IDS])
})

afterAll(async () => {
  await pool.query(`delete from organizations where id = any($1)`, [[ORG, ORG2, ORG3, OWNERS_ORG]])
  await pool.query(`delete from users where id = any($1)`, [FIXTURE_USER_IDS])
  await pool.end()
})

describe('schema', () => {
  it('staff_profiles exists', async () => {
    const { rows } = await pool.query(`
      select count(*)::int n from information_schema.tables
       where table_name = 'staff_profiles'`)
    expect(rows[0].n).toBe(1)
  })

  it('RLS is enabled', async () => {
    const { rows } = await pool.query(`
      select relrowsecurity from pg_class where relname = 'staff_profiles'`)
    expect(rows[0].relrowsecurity).toBe(true)
  })
})

describe('the trigger seeds a profile for every new member', () => {
  beforeAll(async () => {
    await pool.query(`
      insert into organizations (id, name, slug, created_at)
      values ($1, 'Staff DB Test', 'vt-staff', now())`, [ORG])
    await pool.query(`
      insert into users (id, name, email, email_verified, created_at, updated_at)
      values ('vt_staff_owner', 'VT Staff Owner', 'vt-staff-owner@test.local', true, now(), now())`)
    await pool.query(`
      insert into members (id, user_id, organization_id, role, created_at)
      values ('vt_staff_m_owner', 'vt_staff_owner', $1, 'owner', now())`, [ORG])
  })

  it('a new member gets a profile', async () => {
    const { rows: [seeded] } = await pool.query(`
      select active, team_id from staff_profiles
       where user_id = 'vt_staff_owner' and organization_id = $1`, [ORG])
    expect(seeded).toBeDefined()
    expect(seeded.active).toBe(true)
    expect(seeded.team_id).toBeNull()
  })
})

describe('the unique constraint refuses a second profile for one person in one salon', () => {
  beforeAll(async () => {
    await pool.query(`
      insert into organizations (id, name, slug, created_at)
      values ($1, 'Staff DB Test 2', 'vt-staff2', now())`, [ORG2])
    await pool.query(`
      insert into users (id, name, email, email_verified, created_at, updated_at)
      values ('vt_staff_dup', 'VT Staff Dup', 'vt-staff-dup@test.local', true, now(), now())`)
    // A REAL, complete member of ORG2 -- not a bare users + staff_profiles row
    // with no members row, which would make getStaff('vt_staff_dup', anyOrg)
    // return null on its own inner join regardless of organization scoping,
    // and pass the "another salon's staff never leaks" e2e check for the
    // wrong reason (tests/README.md's own trap, one level deeper).
    await pool.query(`
      insert into members (id, user_id, organization_id, role, created_at)
      values ('vt_staff_m_dup', 'vt_staff_dup', $1, 'stylist', now())`, [ORG2])
  })

  it('a second profile insert for the same (user, org) pair is refused', async () => {
    // The trigger already seeded one row on the members insert above --
    // attempted here explicitly (not read from the catalogue), because a
    // constraint that exists but is deferrable or NOT VALID would still pass
    // a catalogue check while allowing the write.
    await expect(pool.query(`
      insert into staff_profiles (user_id, organization_id) values ('vt_staff_dup', $1)`,
      [ORG2])).rejects.toThrow()
  })
})

describe('no member is left without a profile (backfill + trigger together)', () => {
  it('every existing member has a profile', async () => {
    const { rows: [orphan] } = await pool.query(`
      select count(*)::int n from members m
       where not exists (select 1 from staff_profiles s
                          where s.user_id = m.user_id
                            and s.organization_id = m.organization_id)`)
    expect(orphan.n).toBe(0)
  })
})

describe('the backfill carries real rosters across (run from the migration file itself)', () => {
  // Read out of the migration file, not hand-copied: a copy only proves the
  // copy, the trap this project has fallen into twice (see the file's own
  // comment history). Hoisted so both assertions below reuse the same read.
  const migrationSql = readFileSync('db/migrations/0009_staff_profiles.sql', 'utf8')
  const statements = migrationSql.split('--> statement-breakpoint').map((s) => s.trim())
  const backfillInsert = statements.find((s) =>
    s.includes('insert into staff_profiles (user_id, organization_id)') && s.includes('from members m'))
  const backfillUpdate = statements.find((s) =>
    s.includes('update staff_profiles s') && s.includes('set team_id'))

  beforeAll(async () => {
    // Pre-migration fixture: a branch, a stylist and an owner both already
    // assigned to it via team_members, and -- critically -- no staff_profiles
    // row yet (deleted after the trigger seeds one, to recreate the state the
    // real migration ran against).
    await pool.query(`
      insert into teams (id, name, organization_id, created_at)
      values ('vt_staff_team1', 'Cabang Satu', $1, now())`, [ORG])
    await pool.query(`
      insert into users (id, name, email, email_verified, created_at, updated_at)
      values ('vt_staff_stylist', 'VT Staff Stylist', 'vt-staff-stylist@test.local', true, now(), now())`)
    await pool.query(`
      insert into members (id, user_id, organization_id, role, created_at)
      values ('vt_staff_m_stylist', 'vt_staff_stylist', $1, 'stylist', now())`, [ORG])
    await pool.query(`
      insert into team_members (id, team_id, user_id, created_at)
      values ('vt_staff_tm_stylist', 'vt_staff_team1', 'vt_staff_stylist', now())`)
    // vt_staff_owner (from the trigger describe block above) gets a stray
    // team_members row too. Real invites never do this to an owner, but the
    // migration must not care: the exclusion is by role, not by whether the
    // row exists.
    await pool.query(`
      insert into team_members (id, team_id, user_id, created_at)
      values ('vt_staff_tm_owner', 'vt_staff_team1', 'vt_staff_owner', now())`)
    await pool.query(`
      delete from staff_profiles where organization_id = $1
       and user_id in ('vt_staff_stylist', 'vt_staff_owner')`, [ORG])
  })

  it('found both backfill statements in the migration file', () => {
    expect(backfillInsert).toBeTruthy()
    expect(backfillUpdate).toBeTruthy()
  })

  it('runs the backfill and carries assignment onto a non-management member, excluding management', async () => {
    await pool.query(backfillInsert!)
    await pool.query(backfillUpdate!)

    const { rows: [stylistProfile] } = await pool.query(`
      select team_id from staff_profiles
       where user_id = 'vt_staff_stylist' and organization_id = $1`, [ORG])
    const { rows: [ownerProfile] } = await pool.query(`
      select team_id from staff_profiles
       where user_id = 'vt_staff_owner' and organization_id = $1`, [ORG])

    expect(stylistProfile).toBeDefined()
    expect(ownerProfile).toBeDefined()
    expect(stylistProfile.team_id).toBe('vt_staff_team1')
    expect(ownerProfile.team_id).toBeNull()
  })
})

describe('assignment does not depend on role strings', () => {
  // The bug this replaces: a custom management role like 'manajer' is not in
  // array['owner', 'admin'], so an old team_members + role-deny-list
  // predicate counted its holder as staff. The trigger must seed team_id
  // null regardless of a pre-existing team_members row -- assignment is a
  // staff_profiles row, never a role match. (The branch-deactivation-block
  // consequence of this is exercised through the real screen in
  // tests/e2e/staff.spec.ts.)
  beforeAll(async () => {
    await pool.query(`
      insert into teams (id, name, organization_id, created_at)
      values ('vt_staff_team_role', 'Cabang Role', $1, now())`, [ORG])
    await pool.query(`
      insert into users (id, name, email, email_verified, created_at, updated_at)
      values ('vt_staff_manajer', 'VT Staff Manajer', 'vt-staff-manajer@test.local', true, now(), now())`)
    await pool.query(`
      insert into members (id, user_id, organization_id, role, created_at)
      values ('vt_staff_m_manajer', 'vt_staff_manajer', $1, 'manajer', now())`, [ORG])
    await pool.query(`
      insert into team_members (id, team_id, user_id, created_at)
      values ('vt_staff_tm_manajer', 'vt_staff_team_role', 'vt_staff_manajer', now())`)
  })

  it('the trigger seeded a profile with no branch, despite the team_members row', async () => {
    const { rows: [manajerProfile] } = await pool.query(`
      select team_id from staff_profiles
       where user_id = 'vt_staff_manajer' and organization_id = $1`, [ORG])
    expect(manajerProfile?.team_id).toBeNull()
  })
})

describe('countResource(\'staff\') SQL facts', () => {
  // The product decision ("deactivation frees a seat") is proven in
  // tests/e2e/staff.spec.ts by a creation that was refused succeeding
  // afterwards -- these are the underlying SQL facts the count is built on,
  // asserted directly against the real function.
  process.env.DATABASE_URL = TEST_DATABASE_URL
  const countPromise = import('../lib/plan/entitlements').then((m) => m.countResource)

  beforeAll(async () => {
    await pool.query(`
      insert into organizations (id, name, slug, created_at)
      values ($1, 'Staff DB Count Test', 'vt-staff-count', now())`, [ORG3])
    await pool.query(`
      insert into users (id, name, email, email_verified, created_at, updated_at)
      values ('vt_staff_count_owner', 'VT Count Owner', 'vt-staff-count-owner@test.local', true, now(), now())`)
    await pool.query(`
      insert into members (id, user_id, organization_id, role, created_at)
      values ('vt_staff_count_m_owner', 'vt_staff_count_owner', $1, 'owner', now())`, [ORG3])
  })

  it('the owner alone counts as one seat', async () => {
    const countResource = await countPromise
    expect(await countResource(ORG3, 'staff')).toBe(1)
  })

  it('an active stylist adds a seat', async () => {
    await pool.query(`
      insert into users (id, name, email, email_verified, created_at, updated_at)
      values ('vt_staff_count_stylist', 'VT Count Stylist', 'vt-staff-count-stylist@test.local', true, now(), now())`)
    await pool.query(`
      insert into members (id, user_id, organization_id, role, created_at)
      values ('vt_staff_count_m_stylist', 'vt_staff_count_stylist', $1, 'stylist', now())`, [ORG3])
    const countResource = await countPromise
    expect(await countResource(ORG3, 'staff')).toBe(2)
  })

  it('a deactivated profile does not count', async () => {
    await pool.query(`
      update staff_profiles set active = false
       where user_id = 'vt_staff_count_stylist' and organization_id = $1`, [ORG3])
    const countResource = await countPromise
    expect(await countResource(ORG3, 'staff')).toBe(1)
  })

  it('a member with no profile row at all still counts (coalesce defaults to counted, never a free seat)', async () => {
    await pool.query(`
      delete from staff_profiles
       where user_id = 'vt_staff_count_stylist' and organization_id = $1`, [ORG3])
    const countResource = await countPromise
    expect(await countResource(ORG3, 'staff')).toBe(2)
  })
})

describe('the ownerless-salon guards (deactivateStaff, read out of lib/staff.ts)', () => {
  // The statement is READ OUT OF lib/staff.ts, not copied here -- a copy only
  // proves the copy. Hoisted above the tests that use it. Task 2 moved this
  // statement out of actions.ts and into deactivateStaff() so the actor could
  // be threaded through it -- same statement, new home, one extra parameter.
  const actionsSrc = readFileSync('lib/staff.ts', 'utf8')
  const sqlStart = actionsSrc.indexOf('with owners as materialized')
  const sqlEnd = actionsSrc.indexOf('returning user_id', sqlStart)
  const deactivateSql = actionsSrc.slice(sqlStart, sqlEnd + 'returning user_id'.length)
    .replaceAll('${organizationId}', '$1').replaceAll('${userId}', '$2')
    .replaceAll('${actorUserId}', '$3')
  // Any real user id satisfies deleted_by's FK -- these tests assert the
  // owner-guard, not who gets recorded as having deactivated whom.
  const ACTOR = 'vt_staff_owner1'

  const activeOwners = async () => (await pool.query(`
    select count(*)::int n from staff_profiles s
      join members m on m.user_id = s.user_id and m.organization_id = s.organization_id
     where s.organization_id = $1 and s.active
       and (string_to_array(m.role, ',') && array['owner'])`, [OWNERS_ORG])).rows[0].n

  /**
   * ROLES FIRST, then reactivate.
   *
   * The order is load-bearing now. Reactivating a demoted owner leaves the
   * salon with no active owner at that instant, and since migration 0025 the
   * database refuses that -- so the old order (active, then roles) fails on
   * its own tidying-up.
   */
  const resetTwoActiveOwners = async () => {
    await pool.query(`
      update members set role = 'owner'
       where organization_id = $1 and user_id in ($2, $3)`,
      [OWNERS_ORG, 'vt_staff_owner1', 'vt_staff_owner2'])
    await pool.query(`
      update staff_profiles set active = true, deleted_at = null
       where organization_id = $1`, [OWNERS_ORG])
  }

  beforeAll(async () => {
    await pool.query(`
      insert into organizations (id, name, slug, created_at)
      values ($1, 'Staff DB Owners Test', 'vt-staff-owners', now())`, [OWNERS_ORG])
    await pool.query(`
      insert into users (id, name, email, email_verified, created_at, updated_at)
      values ('vt_staff_owner1', 'VT Owner One', 'vt-staff-owner1@test.local', true, now(), now()),
             ('vt_staff_owner2', 'VT Owner Two', 'vt-staff-owner2@test.local', true, now(), now())`)
    await pool.query(`
      insert into members (id, user_id, organization_id, role, created_at)
      values ('vt_staff_m_owner1', 'vt_staff_owner1', $1, 'owner', now()),
             ('vt_staff_m_owner2', 'vt_staff_owner2', $1, 'owner', now())`, [OWNERS_ORG])
  })

  it('found the deactivation statement, locking clause and all', () => {
    expect(sqlStart).not.toBe(-1)
    expect(sqlEnd).not.toBe(-1)
    expect(deactivateSql).toContain('for update of s, m')
  })

  // Negative control -- proves the `of s, m` fix actually matters, the way
  // tests/README.md asks: break it, watch the specific claim fail, restore,
  // watch it pass. The literal production file could not be edited for this
  // (the sandbox refuses to run tests against a weakened concurrency/security
  // guard, which is the right call for a file nobody should ever ship
  // weakened) -- so the break is a mechanically-derived COPY of the exact
  // statement just read out of actions.ts above, with only its lock clause
  // narrowed back to what a `for update of s` alone would have been. Same
  // SQL, same two real Postgres connections, same race as the passing test
  // right below it -- the only variable is the lock set.
  it('with the lock narrowed to `of s`, the DATABASE still refuses the race', async () => {
    // This test used to prove that weakening the lock reached zero active
    // owners. It no longer can, and that is the point: migration 0025 moved
    // the guarantee into a deferrable constraint trigger, so the lock is now
    // the friendly half -- it turns the common case into Indonesian copy
    // rather than a constraint error -- and the database is what is actually
    // true.
    //
    // Still a real assertion: remove the trigger and this fails, because the
    // weakened lock lets both transactions through.
    expect(deactivateSql).toContain('for update of s, m') // guards the substitution below
    const weakenedSql = deactivateSql.replace('for update of s, m', 'for update of s')

    const d1 = await pool.connect()
    const d2 = await pool.connect()
    try {
      await d1.query('begin')
      await d2.query('begin')
      // Exactly what auth.api.updateMemberRole writes: the members row alone.
      await d1.query(`
        update members set role = 'admin'
         where user_id = 'vt_staff_owner2' and organization_id = $1`, [OWNERS_ORG])
      // With the lock narrowed to `s` only, this does NOT need owner2's
      // members row at all -- it proceeds immediately, uncommitted, still
      // counting owner2 as an owner (its own snapshot predates d1's write).
      const raceB = await d2.query(weakenedSql, [OWNERS_ORG, 'vt_staff_owner1', ACTOR])
      expect(raceB.rows, 'the weakened statement itself still matches').toHaveLength(1)

      const results = await Promise.allSettled([d1.query('commit'), d2.query('commit')])
      expect(results.filter((r) => r.status === 'rejected'),
        'one of them is refused at commit').toHaveLength(1)
      expect(await activeOwners(), 'and the salon keeps an owner').toBe(1)
    } finally {
      d1.release()
      d2.release()
    }
    await resetTwoActiveOwners()
  })

  it('the statement refuses to deactivate the LAST active owner, single-file', async () => {
    await pool.query(`
      update staff_profiles set active = false
       where organization_id = $1 and user_id = 'vt_staff_owner2'`, [OWNERS_ORG])
    const result = await pool.query(deactivateSql, [OWNERS_ORG, 'vt_staff_owner1', ACTOR])
    expect(result.rows).toHaveLength(0)
    expect(await activeOwners()).toBe(1)
    await resetTwoActiveOwners()
  })

  // The load-bearing race: two OWNERS deactivating EACH OTHER at once. Both
  // snapshots would see two owners under a check-then-act guard, so a bare
  // `for update` on the row being written is not enough -- the materialized
  // CTE locks every active owner ROW of the salon first, so the loser blocks,
  // re-reads under EvalPlanQual, counts one and refuses.
  //
  // Proven by CONNECTION SEQUENCING, not a sleep: c2's query is fired without
  // being awaited while c1's transaction is still open, and is only awaited
  // AFTER c1 commits. If the lock set did not cover c2's target row, c2 would
  // never have blocked on c1 at all -- it would have read a stale two-owner
  // count and both would succeed, which the final assertions below would
  // catch (raceB would have rowCount 1, and the salon would have zero active
  // owners).
  it('two owners deactivating each other: one succeeds, the other blocks then refuses, and an owner survives', async () => {
    const c1 = await pool.connect()
    const c2 = await pool.connect()
    try {
      await c1.query('begin')
      await c2.query('begin')
      const raceA = await c1.query(deactivateSql, [OWNERS_ORG, 'vt_staff_owner1', ACTOR])
      // Fired, not awaited: c2 needs owner1's now-locked row (part of the
      // "every active owner" CTE), so this call blocks in Postgres until c1
      // commits or rolls back.
      const pending = c2.query(deactivateSql, [OWNERS_ORG, 'vt_staff_owner2', ACTOR])
      await c1.query('commit')
      const raceB = await pending
      await c2.query('commit')

      expect(raceA.rows).toHaveLength(1)
      expect(raceB.rows).toHaveLength(0)
      expect(await activeOwners()).toBeGreaterThanOrEqual(1)
    } finally {
      c1.release()
      c2.release()
    }
    await resetTwoActiveOwners()
  })

  // The second race the `of s, m` fix specifically closes. Owner-ness is read
  // from members.role, and a role change (updateStaffRoleAction) writes ONLY
  // the members row -- so with `for update of s` alone, a demotion of owner 2
  // and a deactivation of owner 1 never contend: both read "2 owners" and
  // both commit, leaving zero. Locking m as well as s serialises this: the
  // deactivation blocks behind the uncommitted demotion, then re-reads and
  // sees only one owner left, and refuses to remove the last one.
  it('demote-one-owner || deactivate-the-other: the deactivation blocks, then refuses once the demotion lands', async () => {
    const d1 = await pool.connect()
    const d2 = await pool.connect()
    try {
      await d1.query('begin')
      await d2.query('begin')
      // Exactly what auth.api.updateMemberRole writes: the members row alone.
      await d1.query(`
        update members set role = 'admin'
         where user_id = 'vt_staff_owner2' and organization_id = $1`, [OWNERS_ORG])
      // Needs owner2's members row (locked by d1, uncommitted) as part of the
      // "every active owner" CTE for owner1's own deactivation -- blocks.
      const pending = d2.query(deactivateSql, [OWNERS_ORG, 'vt_staff_owner1', ACTOR])
      await d1.query('commit')
      const demoteRace = await pending
      await d2.query('commit')

      expect(demoteRace.rows).toHaveLength(0)
      expect(await activeOwners()).toBeGreaterThanOrEqual(1)
    } finally {
      d1.release()
      d2.release()
    }
    await resetTwoActiveOwners()
  })

  // Demote-versus-DEMOTE is a documented, ACCEPTED gap (the `ponytail:`
  // comment in app/dashboard/(shell)/staff/actions.ts, updateStaffRoleAction): two owners
  // demoting EACH OTHER touch no shared lock at all -- better-auth's own
  // updateMemberRole writes its own members row on its own connection with a
  // guard that only fires on self-demotion, and updateStaffRoleAction's own
  // last-owner check reads activeOwnerCount BEFORE the write, not after. This
  // test documents the gap as it exists today; it is NOT asserting the guard
  // works, and must not be read as such. If this test ever starts failing
  // because the gap was closed, delete it and update the ponytail comment.
  it('CLOSED: demote-one-owner || demote-the-other is refused, and the salon keeps an owner', async () => {
    // This test used to assert the OPPOSITE -- that the race reached zero
    // active owners -- and it was right: neither connection touches the
    // other's row, so there was no lock for either to block on, and the
    // application could not fix it because better-auth writes the members row
    // on its own connection.
    //
    // Migration 0025 closes it in the database: a DEFERRABLE constraint
    // trigger that fires at COMMIT with a fresh snapshot, so whichever
    // transaction commits second sees the first's demote and is refused.
    const e1 = await pool.connect()
    const e2 = await pool.connect()
    try {
      await e1.query('begin')
      await e2.query('begin')
      const p1 = e1.query(`
        update members set role = 'admin'
         where user_id = 'vt_staff_owner1' and organization_id = $1`, [OWNERS_ORG])
      const p2 = e2.query(`
        update members set role = 'admin'
         where user_id = 'vt_staff_owner2' and organization_id = $1`, [OWNERS_ORG])
      await Promise.all([p1, p2])

      const results = await Promise.allSettled([e1.query('commit'), e2.query('commit')])
      expect(results.filter((r) => r.status === 'fulfilled'),
        'exactly one demotion survives').toHaveLength(1)
      expect(await activeOwners(), 'and the salon is never ownerless').toBe(1)
    } finally {
      e1.release()
      e2.release()
    }
    // Restore for anything after this in the file.
    await pool.query(`
      update members set role = 'owner'
       where organization_id = $1 and user_id in ('vt_staff_owner1', 'vt_staff_owner2')`,
      [OWNERS_ORG])
  })
})

describe('listStaff paging', () => {
  // Own org and own users, not the fixtures above: the paging assertions need
  // an exact roster size (30), and reusing FIXTURE_USER_IDS would make that
  // count a moving target as earlier describe blocks add and remove people.
  const LIST_ORG = 'vt_staff_list_org'
  const ids = Array.from({ length: 30 }, (_, i) => `vt_staff_list_${String(i).padStart(3, '0')}`)
  const q = (params: Record<string, string> = {}) => parseListQuery(STAFF_LIST, params)

  beforeAll(async () => {
    await pool.query(`delete from organizations where id = $1`, [LIST_ORG])
    await pool.query(`delete from users where id = any($1)`, [ids])
    await pool.query(`
      insert into organizations (id, name, slug, created_at)
      values ($1, 'Staff List Test', 'vt-staff-list', now())`, [LIST_ORG])
    // The free plan's staff cap (3, see migration 0026's seat-cap trigger)
    // would refuse this fixture's 30 rows -- move to the uncapped 'business'
    // plan (no plan_limits row for a resource means unlimited).
    await pool.query(`
      update subscriptions set plan_id = (select id from plans where key = 'business')
       where organization_id = $1`, [LIST_ORG])
    // 30 rows, and DELIBERATELY duplicated names -- same reasoning as
    // customers.db.test.ts's paging fixture: a non-unique sort column is what
    // makes paging non-deterministic without a tiebreaker.
    for (const id of ids) {
      await pool.query(`
        insert into users (id, name, email, email_verified, created_at, updated_at)
        values ($1, 'Sama Persis', $2, true, now(), now())`, [id, `${id}@test.local`])
      await pool.query(`
        insert into members (id, user_id, organization_id, role, created_at)
        values ($1, $2, $3, 'stylist', now())`, [`${id}_m`, id, LIST_ORG])
    }
  })

  afterAll(async () => {
    await pool.query(`delete from organizations where id = $1`, [LIST_ORG])
    await pool.query(`delete from users where id = any($1)`, [ids])
  })

  it('returns one page and the true total', async () => {
    const r = await listStaff(LIST_ORG, q())
    expect(r.rows).toHaveLength(25)
    expect(r.total).toBe(30)
    expect(r.pages).toBe(2)
    expect(r.page).toBe(1)
  })

  it('pages through 30 identical names without repeating or losing one', async () => {
    // Proves paging returns every row of THIS dataset exactly once. As
    // customers.db.test.ts's equivalent test notes, this does NOT prove the
    // tiebreaker is present -- see tests/list-query.test.ts's `orderBy` suite
    // for that.
    const seen = new Set<string>()
    for (const page of ['1', '2']) {
      const r = await listStaff(LIST_ORG, q({ page }))
      for (const row of r.rows) seen.add(row.userId)
    }
    expect(seen.size, 'every row seen exactly once across two pages').toBe(30)
  })

  it('clamps a page past the end to the last page', async () => {
    const r = await listStaff(LIST_ORG, q({ page: '999' }))
    expect(r.page).toBe(2)
    expect(r.rows).toHaveLength(5)
  })

  // members carries no unique on (user_id, organization_id) -- deliberately,
  // per migration 0010. A plain count(*) over the members join therefore
  // reports one person twice, and the list header would say "1-25 dari 31"
  // above 25 rows. This is the only one of the six resources where that is
  // possible (spec §3.2's correction, Task 6).
  it('counts a person once even with two membership rows', async () => {
    const baseline = (await listStaff(LIST_ORG, q())).total
    const staffA = ids[0]
    await pool.query(`
      insert into members (id, user_id, organization_id, role, created_at)
      values ($1, $2, $3, 'stylist', now())`, [`${staffA}_m2`, staffA, LIST_ORG])

    const r = await listStaff(LIST_ORG, q())
    expect(r.total, 'the person is counted once').toBe(baseline)
    // The page query needs the same de-duplication as the count: not just an
    // unchanged total, but the doubly-membered person appearing exactly once
    // among the actual rows (ids[0] sorts first under the name tie -- see the
    // paging fixture's comment -- so it is always on this first page), not
    // twice at the cost of someone else falling off the page.
    expect(r.rows.filter((s) => s.userId === staffA)).toHaveLength(1)
    expect(r.rows).toHaveLength(25)
  })

  // staffOf is the unpaged building block the calendar's lane list and the
  // POS performer picker both read directly (no page, no count) -- it has
  // the exact same members-join fan-out as listStaff's page query, and a
  // picker showing the same stylist twice is worse than a wrong count: the
  // person choosing has no way to tell the two entries apart. Reuses the
  // duplicate-membership row the previous test left in place, rather than
  // inserting its own.
  it('staffOf also returns the person once, not twice', async () => {
    const all = await staffOf(LIST_ORG)
    expect(all.filter((s) => s.userId === ids[0])).toHaveLength(1)
  })
})

/**
 * Task 5: `branch` folded into STAFF_LIST.filters (it used to be a third,
 * un-contracted parameter -- app/dashboard/(shell)/staff/page.tsx read it off
 * searchParams directly) and `active` added to match the other four
 * resources that carry the column. Own fixture, not LIST_ORG above: that
 * describe's own afterAll deletes LIST_ORG once its tests finish, and these
 * need a real team to filter by, which LIST_ORG's roster never assigns.
 */
describe('listStaff filters', () => {
  const FILTER_ORG = 'vt_staff_filter_org'
  const FILTER_TEAM = 'vt_staff_filter_team'
  const uOwner = 'vt_staff_filter_owner' // active, unassigned -- keeps the salon a valid owner
  const uA = 'vt_staff_filter_a' // active, assigned to FILTER_TEAM
  const uB = 'vt_staff_filter_b' // INACTIVE, assigned to FILTER_TEAM
  const uC = 'vt_staff_filter_c' // active, unassigned
  const users = [uOwner, uA, uB, uC]
  // A second, unrelated salon with its OWN real team and its own staff member
  // assigned to it -- Finding 6 of the final whole-branch review: `branch` is
  // the newest URL-controlled filter here, and the other five list resources
  // each have a "never returns another salon's X" test exercised against a
  // REAL foreign id, never just a nonsense string. `listStaff`'s WHERE joins
  // `staff_profiles s on s.organization_id = m.organization_id` -- pass this
  // team id to FILTER_ORG's own query and, if `m.organization_id =
  // ${organizationId}` in listStaff's WHERE were ever dropped, FOREIGN_USER's
  // own row (paired with ITS OWN org's staff_profiles via that join) would
  // leak into FILTER_ORG's results. With the guard in place it does not.
  const FOREIGN_ORG = 'vt_staff_filter_foreign_org'
  const FOREIGN_TEAM = 'vt_staff_filter_foreign_team'
  const FOREIGN_USER = 'vt_staff_filter_foreign_user'
  const q = (params: Record<string, string> = {}) => parseListQuery(STAFF_LIST, params)

  beforeAll(async () => {
    await pool.query(`delete from organizations where id = any($1)`, [[FILTER_ORG, FOREIGN_ORG]])
    await pool.query(`delete from users where id = any($1)`, [[...users, FOREIGN_USER]])
    await pool.query(`
      insert into organizations (id, name, slug, created_at)
      values ($1, 'Staff Filter Test', 'vt-staff-filter', now()),
             ($2, 'Staff Filter Foreign Test', 'vt-staff-filter-foreign', now())`,
      [FILTER_ORG, FOREIGN_ORG])
    await pool.query(`
      insert into teams (id, name, organization_id, created_at)
      values ($1, 'Cabang Filter', $2, now()), ($3, 'Cabang Asing', $4, now())`,
      [FILTER_TEAM, FILTER_ORG, FOREIGN_TEAM, FOREIGN_ORG])
    // The free plan's staff cap (3) would refuse this fixture's four rows --
    // same move as the paging describe above.
    await pool.query(`
      update subscriptions set plan_id = (select id from plans where key = 'business')
       where organization_id = $1`, [FILTER_ORG])
    for (const id of users) {
      await pool.query(`
        insert into users (id, name, email, email_verified, created_at, updated_at)
        values ($1, $1, $2, true, now(), now())`, [id, `${id}@test.local`])
      await pool.query(`
        insert into members (id, user_id, organization_id, role, created_at)
        values ($1, $2, $3, $4, now())`, [`${id}_m`, id, FILTER_ORG, id === uOwner ? 'owner' : 'stylist'])
    }
    // The members insert above already fired the seeding trigger, so a
    // staff_profiles row exists for each with team_id null and active true
    // (see the schema describe up top) -- assignment and deactivation are
    // this describe's own job, same division as assignBranch's docstring.
    // uOwner is left untouched throughout: deactivating uB below fires the
    // "keep an owner" constraint trigger (migration 0025) for the WHOLE
    // organization, not just the row being touched, so a fixture with no
    // active owner at all fails that check for a reason that has nothing to
    // do with the filter under test here.
    await pool.query(`
      update staff_profiles set team_id = $1
       where organization_id = $2 and user_id = any($3)`, [FILTER_TEAM, FILTER_ORG, [uA, uB]])
    await pool.query(`
      update staff_profiles set active = false
       where organization_id = $1 and user_id = $2`, [FILTER_ORG, uB])

    // FOREIGN_ORG's own owner (required by the same "keep an owner" trigger)
    // and its one real staff member, assigned to FOREIGN_TEAM.
    await pool.query(`
      insert into users (id, name, email, email_verified, created_at, updated_at)
      values ($1, $1, $2, true, now(), now())`, [FOREIGN_USER, `${FOREIGN_USER}@test.local`])
    await pool.query(`
      insert into users (id, name, email, email_verified, created_at, updated_at)
      values ($1, $1, $2, true, now(), now())`,
      [`${FOREIGN_USER}_owner`, `${FOREIGN_USER}_owner@test.local`])
    await pool.query(`
      insert into members (id, user_id, organization_id, role, created_at)
      values ($1, $2, $3, 'owner', now()), ($4, $5, $3, 'stylist', now())`,
      [`${FOREIGN_USER}_owner_m`, `${FOREIGN_USER}_owner`, FOREIGN_ORG,
        `${FOREIGN_USER}_m`, FOREIGN_USER])
    await pool.query(`
      update staff_profiles set team_id = $1
       where organization_id = $2 and user_id = $3`, [FOREIGN_TEAM, FOREIGN_ORG, FOREIGN_USER])
  })

  afterAll(async () => {
    await pool.query(`delete from organizations where id = any($1)`, [[FILTER_ORG, FOREIGN_ORG]])
    await pool.query(`delete from users where id = any($1)`,
      [[...users, FOREIGN_USER, `${FOREIGN_USER}_owner`]])
  })

  it('narrows to one branch', async () => {
    const r = await listStaff(FILTER_ORG, q({ branch: FILTER_TEAM }))
    expect(r.rows.map((s) => s.userId).sort()).toEqual([uA, uB].sort())
  })

  it('an id naming no branch at all matches nobody -- the same behaviour the old unchecked ?branch= already had, now reached through the contract', async () => {
    const r = await listStaff(FILTER_ORG, q({ branch: 'not-a-real-branch' }))
    expect(r.total).toBe(0)
  })

  it('never returns another salon\'s staff, even given that salon\'s real team id', async () => {
    const r = await listStaff(FILTER_ORG, q({ branch: FOREIGN_TEAM }))
    expect(r.total).toBe(0)
    expect(r.rows.map((s) => s.userId)).not.toContain(FOREIGN_USER)
  })

  it('narrows to active or inactive staff', async () => {
    const active = await listStaff(FILTER_ORG, q({ active: 'true' }))
    expect(active.rows.map((s) => s.userId)).not.toContain(uB)
    // uOwner is active too (it has to be, per the fixture note above), so
    // this asserts membership rather than the exact set.
    expect(active.rows.map((s) => s.userId)).toEqual(expect.arrayContaining([uA, uC]))

    const inactive = await listStaff(FILTER_ORG, q({ active: 'false' }))
    expect(inactive.rows.map((s) => s.userId)).toEqual([uB])
  })

  it('combines branch and active', async () => {
    const r = await listStaff(FILTER_ORG, q({ branch: FILTER_TEAM, active: 'false' }))
    expect(r.rows.map((s) => s.userId)).toEqual([uB])
  })
})

/**
 * Finding 1 of the final whole-branch review: a person who holds TWO
 * membership rows in the same salon (one 'owner', one something weaker) must
 * still read as an owner everywhere `role.split(',').includes('owner')` is
 * checked -- app/dashboard/(shell)/staff/actions.ts gates four owner-only
 * guards on exactly that (demotion, the last-owner check, deactivation and,
 * sharpest of all, a password reset), and getStaff/staffOf/listStaff are the
 * only path any of them has to `target.role`.
 *
 * Two membership rows for one person in one salon is reachable in practice:
 * better-auth only checks "already a member" at INVITE time, so inviting an
 * address, creating the same person through "Tambah staf" and then accepting
 * the stale invitation produces two `members` rows for the same
 * (user_id, organization_id) pair -- `members` carries no unique constraint
 * on that pair by design (migration 0010_services.sql).
 *
 * `min(m.role)` -- what staffOf/listStaff used to select -- is alphabetical:
 * `min('owner', 'admin')` is 'admin'. That silently downgraded an owner with
 * a second, weaker membership row to non-owner everywhere, including the
 * password-reset guard: an admin resetting the password of someone who
 * secretly still holds 'owner' takes over the salon. This test is what
 * catches a regression back to MIN (or any other collapse to one role) --
 * confirmed failing against `min(m.role)` before the fix landed here.
 */
describe('a person with two membership rows is never hidden as an owner', () => {
  const ORG = 'vt_staff_dual_role_org'
  const USER = 'vt_staff_dual_role_user'

  beforeAll(async () => {
    await pool.query(`delete from organizations where id = $1`, [ORG])
    await pool.query(`delete from users where id = $1`, [USER])
    await pool.query(`
      insert into organizations (id, name, slug, created_at)
      values ($1, 'Staff Dual Role Test', 'vt-staff-dual-role', now())`, [ORG])
    await pool.query(`
      insert into users (id, name, email, email_verified, created_at, updated_at)
      values ($1, 'VT Dual Role', 'vt-staff-dual-role@test.local', true, now(), now())`, [USER])
    // The alphabetically WEAKER role second, deliberately: MIN(m.role) would
    // pick 'admin' here ('admin' < 'owner'), which is exactly the failure
    // mode this test exists to catch.
    await pool.query(`
      insert into members (id, user_id, organization_id, role, created_at)
      values ($1, $3, $2, 'owner', now()), ($4, $3, $2, 'admin', now())`,
      [`${USER}_m_owner`, ORG, USER, `${USER}_m_admin`])
  })

  afterAll(async () => {
    await pool.query(`delete from organizations where id = $1`, [ORG])
    await pool.query(`delete from users where id = $1`, [USER])
  })

  it('getStaff reads the person as an owner, not the alphabetically weaker role', async () => {
    const staff = await getStaff(USER, ORG)
    expect(staff).not.toBeNull()
    expect(staff!.role.split(',')).toContain('owner')
  })
})

describe('every staff_profiles row with a branch has a matching team_members row (spec §7.14)', () => {
  it('holds across every fixture this file created', async () => {
    const { rows: [pairing] } = await pool.query(`
      select count(*)::int n from staff_profiles s
       where s.team_id is not null
         and not exists (select 1 from team_members tm
                          where tm.user_id = s.user_id and tm.team_id = s.team_id)`)
    expect(pairing.n).toBe(0)
  })
})

/**
 * Task 4: getStaff's audit trail (spec §5). Raw SQL against staff_profiles
 * for the fixture, same as the dual-role describe block above -- provisioning
 * a real login through better-auth is what the e2e suite already does for
 * the exact provisionStaff-then-assignBranch suppression scenario
 * (tests/e2e/staff.spec.ts, "provisioning a stylist with a branchId").
 */
describe('Task 4: getStaff surfaces the audit trail', () => {
  const ORG = 'vt_staff_audit_org'
  const USER = 'vt_staff_audit_user'
  const ACTOR = 'vt_staff_audit_actor'
  const OTHER = 'vt_staff_audit_other'

  beforeAll(async () => {
    await pool.query(`delete from organizations where id = $1`, [ORG])
    await pool.query(`delete from users where id = any($1)`, [[USER, ACTOR, OTHER]])
    await pool.query(`
      insert into organizations (id, name, slug, created_at)
      values ($1, 'Staff Audit Test', 'vt-staff-audit', now())`, [ORG])
    await pool.query(`
      insert into users (id, name, email, email_verified, created_at, updated_at)
      values ($1, 'VT Audit Staff', 'vt-staff-audit@test.local', true, now(), now()),
             ($2, 'VT Audit Actor', 'vt-staff-audit-actor@test.local', true, now(), now()),
             ($3, 'VT Audit Other', 'vt-staff-audit-other@test.local', true, now(), now())`,
      [USER, ACTOR, OTHER])
    await pool.query(`
      insert into members (id, user_id, organization_id, role, created_at)
      values ($1, $2, $3, 'admin', now())`, [`${USER}_m`, USER, ORG])
    // A second, active owner -- ACTOR itself, never actually staffed anywhere
    // in this org -- so deactivating USER's staff_profiles row below does not
    // trip the last-active-owner guard (migration 0025), which is not what
    // this describe block is testing.
    await pool.query(`
      insert into members (id, user_id, organization_id, role, created_at)
      values ($1, $2, $3, 'owner', now())`, [`${ACTOR}_m`, ACTOR, ORG])
  })

  afterAll(async () => {
    await pool.query(`delete from organizations where id = $1`, [ORG])
    await pool.query(`delete from users where id = any($1)`, [[USER, ACTOR, OTHER]])
  })

  it('names who created the row, with nothing to report before any edit', async () => {
    await pool.query(
      `update staff_profiles set created_by = $1 where user_id = $2 and organization_id = $3`,
      [ACTOR, USER, ORG])
    const staff = await getStaff(USER, ORG)
    expect(staff!.audit.createdByName).toBe('VT Audit Actor')
    expect(staff!.audit.updatedByName).toBeNull()
  })

  it('suppresses the diubah line when the SAME actor touches the row seconds after creating it', async () => {
    // Mirrors provisionStaff + assignBranch (lib/staff.ts): insert, then a
    // same-actor update moments later -- the exact shape Task 4's brief
    // calls out as noise, not a real edit.
    await pool.query(
      `update staff_profiles set created_by = $1, created_at = now() - interval '1 second'
        where user_id = $2 and organization_id = $3`,
      [ACTOR, USER, ORG])
    // A separate statement, deliberately: touch_updated_at (Task 1) stamps
    // updated_at = now() itself, so it cannot be set directly in the same
    // UPDATE as created_at above.
    await pool.query(
      `update staff_profiles set updated_by = $1 where user_id = $2 and organization_id = $3`,
      [ACTOR, USER, ORG])
    const staff = await getStaff(USER, ORG)
    expect(staff!.audit.updatedByName).toBeNull()
  })

  it('shows the diubah line when a DIFFERENT actor changes the row moments later', async () => {
    await pool.query(
      `update staff_profiles set created_by = $1, created_at = now() - interval '1 second'
        where user_id = $2 and organization_id = $3`,
      [ACTOR, USER, ORG])
    await pool.query(
      `update staff_profiles set updated_by = $1 where user_id = $2 and organization_id = $3`,
      [OTHER, USER, ORG])
    const staff = await getStaff(USER, ORG)
    expect(staff!.audit.updatedByName).toBe('VT Audit Other')
  })

  it('shows the diubah line for the SAME actor once real time has passed', async () => {
    await pool.query(
      `update staff_profiles set created_by = $1, created_at = now() - interval '1 hour'
        where user_id = $2 and organization_id = $3`,
      [ACTOR, USER, ORG])
    await pool.query(
      `update staff_profiles set updated_by = $1 where user_id = $2 and organization_id = $3`,
      [ACTOR, USER, ORG])
    const staff = await getStaff(USER, ORG)
    expect(staff!.audit.updatedByName).toBe('VT Audit Actor')
  })

  it('shows the deactivation line, independent of the diubah line', async () => {
    // updated_by reset to null: this describe block reuses one row across
    // tests, and deactivateStaff (Task 3) deliberately never sets updated_by
    // -- this test isolates that state rather than inheriting it from
    // whichever test ran before it.
    await pool.query(
      `update staff_profiles set created_by = $1, updated_by = null,
              deleted_by = $2, deleted_at = now(), active = false
        where user_id = $3 and organization_id = $4`,
      [ACTOR, OTHER, USER, ORG])
    const staff = await getStaff(USER, ORG)
    expect(staff!.audit.deletedByName).toBe('VT Audit Other')
    expect(staff!.audit.updatedByName).toBeNull()
  })

  // Fix 3 (crud-phase-3 review): the test above proved getStaff's read of
  // deleted_by, but nothing proved deactivateStaff (lib/staff.ts:438) is the
  // one WRITING it correctly -- every other test in this describe block sets
  // deleted_by by hand, via raw SQL. Swapping actorUserId for userId there
  // (recording the deactivated person as the author of their own
  // deactivation) would pass the entire suite today. Round-trip through the
  // real function instead, with a distinct actor, the same way
  // branch.db.test.ts already does for deactivateBranch.
  it('deactivateStaff itself stamps the ACTOR, not the target, as deleted_by', async () => {
    await pool.query(
      `update staff_profiles set created_by = null, updated_by = null,
              deleted_by = null, deleted_at = null, active = true
        where user_id = $1 and organization_id = $2`,
      [USER, ORG])
    const closed = await deactivateStaff(USER, ORG, ACTOR)
    expect(closed).toBe(true)
    const staff = await getStaff(USER, ORG)
    expect(staff!.audit.deletedByName).toBe('VT Audit Actor')
    expect(staff!.audit.deletedByName).not.toBe('VT Audit Staff')
  })

  // Fix 1 (crud-phase-3 review): setBaseSalary (lib/payroll.ts) is a write
  // site on this very table, and it took no actor at all -- an owner editing
  // "Gaji pokok" left updated_by null, so this exact audit block reported the
  // record unchanged. Proven the same way the rest of this describe block
  // does: through the real write function, not a raw SQL stand-in for it.
  it('names the editor after setBaseSalary, the same as any other write to this table', async () => {
    await pool.query(
      `update staff_profiles set created_by = $1, created_at = now() - interval '1 hour',
              updated_by = null
        where user_id = $2 and organization_id = $3`,
      [ACTOR, USER, ORG])
    await setBaseSalary(USER, ORG, 5000000, OTHER)
    const staff = await getStaff(USER, ORG)
    expect(staff!.audit.updatedByName).toBe('VT Audit Other')
  })
})
