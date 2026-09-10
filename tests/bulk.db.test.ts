import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from './db'
import { bulkDeactivate, resolveSelection } from '../lib/bulk'
import { deactivateStaff } from '../lib/staff'
import { EXPORT_CAP } from '../lib/list-query'
import { CUSTOMER_LIST, listCustomers, type CustomerRow } from '../lib/customer'

/**
 * `lib/bulk.ts`'s two building blocks, against a real Postgres:
 *
 * - `bulkDeactivate` must report a refusal honestly rather than rounding it
 *   into "done" -- the dishonesty commit 2b8fe2f fixed for role updates
 *   (tests/e2e/staff.spec.ts's "a self-demotion that fails partway..."),
 *   reproduced here for bulk deactivation via `deactivateStaff`'s own
 *   last-active-owner guard (migration 0025, enforced in SQL).
 * - `resolveSelection` must resolve "all matching" against the FILTER, using
 *   the same list function and organizationId the screen used -- never
 *   reaching past the acting user's own salon.
 *
 * Screens, the confirmation copy and the four resources' wiring live in
 * tests/e2e/*.spec.ts instead.
 */
const pool = new Pool({ connectionString: TEST_DATABASE_URL })

const ORG = 'blk_org'
const OUTSIDER_ORG = 'blk_org2'
const ACTOR = 'blk_actor'
const STYLIST = 'blk_stylist'
const LAST_OWNER = 'blk_owner'
const OUTSIDER_CUSTOMER = 'blk_outsider_customer'
const FIXTURE_USER_IDS = [ACTOR, STYLIST, LAST_OWNER]

beforeAll(async () => {
  await pool.query(`delete from organizations where id = any($1)`, [[ORG, OUTSIDER_ORG]])
  await pool.query(`delete from users where id = any($1)`, [FIXTURE_USER_IDS])

  await pool.query(`
    insert into organizations (id, name, slug, created_at) values ($1, 'Blk', 'blk-one', now())`,
    [ORG])
  await pool.query(`
    insert into organizations (id, name, slug, created_at) values ($1, 'Blk Out', 'blk-out', now())`,
    [OUTSIDER_ORG])

  for (const id of FIXTURE_USER_IDS) {
    await pool.query(`
      insert into users (id, name, email, email_verified, created_at, updated_at)
      values ($1, $1, $1 || '@blk.local', true, now(), now())`, [id])
  }

  // ACTOR is a plain admin (only needs to be a valid actorUserId to stamp);
  // STYLIST has no ownership stake at all; LAST_OWNER is the org's only
  // 'owner' row -- deactivateStaff's own CTE must refuse exactly that one.
  // Inserting into `members` alone is enough -- seed_staff_profile() (migration
  // 0009) backfills the matching staff_profiles row itself; a second, explicit
  // insert here would collide with it on (user_id, organization_id).
  for (const [id, role] of [[ACTOR, 'admin'], [STYLIST, 'stylist'], [LAST_OWNER, 'owner']] as const) {
    await pool.query(`
      insert into members (id, user_id, organization_id, role, created_at)
      values ($1 || '_m', $1, $2, $3, now())`, [id, ORG, role])
  }

  // 3 active customers matching `active=true`, 1 inactive (proves the filter
  // actually narrows), 1 in ANOTHER organization (proves the scoping holds).
  await pool.query(`
    insert into customers (id, organization_id, name, active) values
      ('blk_c1', $1, 'Blk C1', true),
      ('blk_c2', $1, 'Blk C2', true),
      ('blk_c3', $1, 'Blk C3', true),
      ('blk_c4', $1, 'Blk C4 Inactive', false)`, [ORG])
  await pool.query(`
    insert into customers (id, organization_id, name, active) values ($1, $2, 'Outsider', true)`,
    [OUTSIDER_CUSTOMER, OUTSIDER_ORG])
})

afterAll(async () => {
  await pool.query(`delete from organizations where id = any($1)`, [[ORG, OUTSIDER_ORG]])
  await pool.query(`delete from users where id = any($1)`, [FIXTURE_USER_IDS])
  await pool.end()
})

describe('bulkDeactivate', () => {
  it('reports a refusal instead of counting it as done', async () => {
    // The last owner cannot be deactivated -- migration 0025 says so in SQL.
    // A bulk call must say that happened, not round it away.
    const out = await bulkDeactivate([STYLIST, LAST_OWNER],
      (id) => deactivateStaff(id, ORG, ACTOR))
    expect(out.done, 'the stylist went').toBe(1)
    expect(out.refused, 'the owner did not, and the caller is told').toBe(1)
    expect(out.total).toBe(2)
  })

  it('counts a fully successful run as zero refusals', async () => {
    const out = await bulkDeactivate([], async () => true)
    expect(out).toEqual({ done: 0, refused: 0, total: 0 })
  })
})

describe('resolveSelection', () => {
  it('resolves "all matching" from the filter, not from ids', async () => {
    // 3 active customers match; the caller sends zero ids.
    const { ids, capped } = await resolveSelection({
      spec: CUSTOMER_LIST, params: { active: 'true' }, ids: [], allMatching: true,
      list: (q) => listCustomers(ORG, q),
      idOf: (r: CustomerRow) => r.id,
    })
    expect(ids).toHaveLength(3)
    expect(ids, "and never another salon's row").not.toContain(OUTSIDER_CUSTOMER)
    expect(capped, 'well under the 10.000 cap').toBe(false)
  })

  it('returns the posted ids untouched when not selecting all matching', async () => {
    const { ids, capped } = await resolveSelection({
      spec: CUSTOMER_LIST, params: {}, ids: ['blk_c1', 'blk_c2'], allMatching: false,
      list: (q) => listCustomers(ORG, q),
      idOf: (r: CustomerRow) => r.id,
    })
    expect(ids).toEqual(['blk_c1', 'blk_c2'])
    expect(capped, 'the cap only applies to "all matching"').toBe(false)
  })

  it('reports capped when "all matching" hits the export cap', async () => {
    // A stub `list`, not 10.001 real rows: the CAP is EXPORT_CAP's own
    // constant, so this only needs to prove resolveSelection reads `total`
    // against it -- lib/list-csv.db.test.ts already proves the real
    // query pays for the cap correctly.
    const { ids, capped } = await resolveSelection({
      spec: CUSTOMER_LIST, params: {}, ids: [], allMatching: true,
      list: async () => ({
        rows: [{ id: 'blk_c1' }] as unknown as CustomerRow[],
        total: EXPORT_CAP + 1, page: 1, perPage: EXPORT_CAP, pages: 2,
      }),
      idOf: (r: CustomerRow) => r.id,
    })
    expect(ids).toEqual(['blk_c1'])
    expect(capped).toBe(true)
  })
})
