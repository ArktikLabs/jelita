import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from './db'

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

describe('the ownerless-salon guards (deactivateStaffAction, read out of actions.ts)', () => {
  // The statement is READ OUT OF actions.ts, not copied here -- a copy only
  // proves the copy. Hoisted above the tests that use it.
  const actionsSrc = readFileSync('app/dashboard/(shell)/staff/actions.ts', 'utf8')
  const sqlStart = actionsSrc.indexOf('with owners as materialized')
  const sqlEnd = actionsSrc.indexOf('returning user_id', sqlStart)
  const deactivateSql = actionsSrc.slice(sqlStart, sqlEnd + 'returning user_id'.length)
    .replaceAll('${organizationId}', '$1').replaceAll('${userId}', '$2')

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
      update staff_profiles set active = true, deactivated_at = null
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
      const raceB = await d2.query(weakenedSql, [OWNERS_ORG, 'vt_staff_owner1'])
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
    const result = await pool.query(deactivateSql, [OWNERS_ORG, 'vt_staff_owner1'])
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
      const raceA = await c1.query(deactivateSql, [OWNERS_ORG, 'vt_staff_owner1'])
      // Fired, not awaited: c2 needs owner1's now-locked row (part of the
      // "every active owner" CTE), so this call blocks in Postgres until c1
      // commits or rolls back.
      const pending = c2.query(deactivateSql, [OWNERS_ORG, 'vt_staff_owner2'])
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
      const pending = d2.query(deactivateSql, [OWNERS_ORG, 'vt_staff_owner1'])
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
