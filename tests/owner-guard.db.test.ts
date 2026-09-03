import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from './db'

/**
 * A salon can never be left with zero active owners.
 *
 * This closes a documented, ACCEPTED gap: the application checked the owner
 * count and then demoted, and two owners demoting each other in the same
 * instant both passed. The application could not fix it -- better-auth's
 * updateMemberRole writes on its own connection, so no application transaction
 * covers both the check and the write, and the two callers share no lock.
 *
 * These assertions therefore go at the TABLE, with two connections. Driving
 * the screen would prove only that one screen is careful.
 */
const pool = new Pool({ connectionString: TEST_DATABASE_URL })

const ORG = 'own_org'
const A = 'own_a'
const B = 'own_b'
const STYLIST = 'own_stylist'

const activeOwners = async () => Number((await pool.query(`
  select count(*)::int n from members m
    join staff_profiles s on s.user_id = m.user_id and s.organization_id = m.organization_id
   where m.organization_id = $1 and s.active
     and 'owner' = any (string_to_array(m.role, ','))`, [ORG])).rows[0].n)

beforeAll(async () => {
  await pool.query(`delete from organizations where id = $1`, [ORG])
  await pool.query(`
    insert into organizations (id, name, slug, created_at)
    values ($1, 'Own', 'own-one', now())`, [ORG])
  for (const id of [A, B, STYLIST]) {
    await pool.query(`
      insert into users (id, name, email, email_verified, created_at, updated_at)
      values ($1, $1, $1 || '@own.local', true, now(), now())`, [id])
  }
})

afterAll(async () => {
  await pool.query(`delete from organizations where id = $1`, [ORG])
  await pool.query(`delete from users where id = any($1)`, [[A, B, STYLIST]])
  await pool.end()
})

beforeEach(async () => {
  // ONE transaction: deleting every member autocommits a state with no owner,
  // which the trigger refuses -- correctly. Deferred means only the end state
  // is checked, so a rebuild that ends with an owner is fine. This is the
  // teardown equivalent of the TRUNCATE the POS suite needs.
  const c = await pool.connect()
  try {
    await c.query('begin')
    await c.query(`delete from members where organization_id = $1`, [ORG])
    for (const [id, role] of [[A, 'owner'], [B, 'owner'], [STYLIST, 'stylist']] as const) {
      await c.query(`
        insert into members (id, user_id, organization_id, role, created_at)
        values ($1 || '_m', $1, $2, $3, now())`, [id, ORG, role])
    }
    await c.query(`update staff_profiles set active = true where organization_id = $1`, [ORG])
    await c.query('commit')
  } finally {
    c.release()
  }
})

describe('the last active owner', () => {
  it('can demote one of two owners', async () => {
    await expect(pool.query(
      `update members set role = 'admin' where user_id = $1 and organization_id = $2`,
      [A, ORG])).resolves.toBeTruthy()
    expect(await activeOwners()).toBe(1)
  })

  it('refuses the demotion that would leave none', async () => {
    await pool.query(
      `update members set role = 'admin' where user_id = $1 and organization_id = $2`, [A, ORG])
    await expect(pool.query(
      `update members set role = 'admin' where user_id = $1 and organization_id = $2`, [B, ORG]))
      .rejects.toThrow(/no active owner/)
    expect(await activeOwners(), 'and the salon still has one').toBe(1)
  })

  it('refuses DEACTIVATING the last owner, the same hole by another door', async () => {
    await pool.query(
      `update members set role = 'admin' where user_id = $1 and organization_id = $2`, [A, ORG])
    await expect(pool.query(
      `update staff_profiles set active = false where user_id = $1 and organization_id = $2`,
      [B, ORG])).rejects.toThrow(/no active owner/)
  })

  it('refuses REMOVING the last owner', async () => {
    await pool.query(
      `update members set role = 'admin' where user_id = $1 and organization_id = $2`, [A, ORG])
    await expect(pool.query(
      `delete from members where user_id = $1 and organization_id = $2`, [B, ORG]))
      .rejects.toThrow(/no active owner/)
  })

  it('allows swapping one owner for another IN ONE TRANSACTION', async () => {
    // Deferred matters here: mid-transaction there is briefly one owner and
    // then the promotion lands. Only the end state is checked, so legitimate
    // multi-step work is not blocked.
    const c = await pool.connect()
    try {
      await c.query('begin')
      await c.query(
        `update members set role = 'admin' where user_id = $1 and organization_id = $2`, [A, ORG])
      await c.query(
        `update members set role = 'admin' where user_id = $1 and organization_id = $2`, [B, ORG])
      await c.query(
        `update members set role = 'owner' where user_id = $1 and organization_id = $2`,
        [STYLIST, ORG])
      await expect(c.query('commit')).resolves.toBeTruthy()
    } finally {
      c.release()
    }
    expect(await activeOwners()).toBe(1)
  })

  it('refuses TWO OWNERS DEMOTING EACH OTHER at the same instant', async () => {
    // The gap this exists to close. Both transactions pass their own check --
    // each still sees the other as an owner -- so the app cannot catch it. The
    // trigger fires at COMMIT and takes a fresh snapshot, so whichever commits
    // second sees the first's demote and is refused.
    const a = await pool.connect()
    const b = await pool.connect()
    try {
      await a.query('begin')
      await b.query('begin')
      await a.query(
        `update members set role = 'admin' where user_id = $1 and organization_id = $2`, [A, ORG])
      await b.query(
        `update members set role = 'admin' where user_id = $1 and organization_id = $2`, [B, ORG])

      const results = await Promise.allSettled([a.query('commit'), b.query('commit')])
      expect(results.filter((r) => r.status === 'fulfilled'),
        'exactly one demotion survives').toHaveLength(1)
    } finally {
      a.release()
      b.release()
    }
    expect(await activeOwners(), 'the salon is never ownerless').toBe(1)
  })

  it('does not block deleting the salon itself', async () => {
    // Deleting the organization cascades into members, and a salon that no
    // longer exists cannot be ownerless -- without the existence check the
    // cascade would raise.
    await pool.query(`
      insert into organizations (id, name, slug, created_at)
      values ('own_temp', 'Temp', 'own-temp', now())`)
    await pool.query(`
      insert into members (id, user_id, organization_id, role, created_at)
      values ('own_temp_m', $1, 'own_temp', 'owner', now())`, [A])
    await expect(pool.query(`delete from organizations where id = 'own_temp'`))
      .resolves.toBeTruthy()
  })
})
