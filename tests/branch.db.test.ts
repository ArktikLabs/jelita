import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from './db'
import { PLANS } from '../scripts/seed-plans.mjs'

/**
 * Branch schema, the seeding trigger/backfill, and the branch_entitlement
 * view's lock ranking -- asserted against a real Postgres rather than mocked,
 * same reasoning as plan.db.test.ts. Guards, redirects, form posts, the
 * switcher's rendered output and the RSC payload live in
 * tests/e2e/branch.spec.ts instead.
 */
const pool = new Pool({ connectionString: TEST_DATABASE_URL })
const FREE = PLANS.find((p) => p.key === 'free')!
const ORG = 'vt_branch_org'
const ORG2 = 'vt_branch_org2'

// lib/plan/branch.ts reads its pool from process.env.DATABASE_URL
// (lib/pg-pool.ts) -- point it at the disposable database before importing,
// same as plan.db.test.ts.
process.env.DATABASE_URL = TEST_DATABASE_URL
const { getBranchStatus } = await import('../lib/plan/branch')
const { branchLabel } = await import('../lib/branch-label')

// Restore from the seed export, never from the live table: reading the live
// value after a crashed run is what would launder a corrupted cap forward.
const restoreBranchCap = () => pool.query(`
  insert into plan_limits (plan_id, resource, cap)
  select id, 'branches', $1 from plans where key = 'free'
  on conflict (plan_id, resource) do update set cap = excluded.cap`,
  [FREE.caps.branches])

beforeAll(async () => {
  await pool.query(`delete from organizations where id = any($1)`, [[ORG, ORG2]])
})

afterAll(async () => {
  await pool.query(`delete from organizations where id = any($1)`, [[ORG, ORG2]])
  await restoreBranchCap()
  await pool.end()
})

describe('the seeding trigger configures every new branch', () => {
  beforeAll(async () => {
    await pool.query(`
      insert into organizations (id, name, slug, created_at)
      values ($1, 'Branch DB Test', 'vt-branch', now())`, [ORG])
    // A literal, older timestamp -- not now(): the next describe block adds a
    // second team at a literal 2026-01-01 offset, which real wall-clock time
    // has since passed, and now() here would make this "older" team the
    // younger one by created_at.
    await pool.query(`
      insert into teams (id, name, organization_id, created_at)
      values ('vt_branch_t1', 'Cabang Satu', $1, '2026-01-01 00:00:01'::timestamp)`, [ORG])
  })

  it('a new team gets exactly one profile row, active', async () => {
    const { rows } = await pool.query(
      `select active from branch_profiles where team_id = 'vt_branch_t1'`)
    expect(rows).toHaveLength(1)
    expect(rows[0].active).toBe(true)
  })

  it('a new team gets exactly seven hours rows, 0..6, none closed', async () => {
    const { rows } = await pool.query(
      `select weekday, closed from branch_hours where team_id = 'vt_branch_t1' order by weekday`)
    expect(rows.map((r) => r.weekday)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(rows.every((r) => r.closed === false)).toBe(true)
  })
})

describe('branch_entitlement ranks active branches only', () => {
  // Regression test for the trap: with a cap of 1 and an OLDER deactivated
  // branch, ranking ALL branches by created_at would leave the only OPEN
  // branch read-only. The view partitions over active branches only
  // (db/migrations/0008_branch_tables.sql).
  const mkTeam = (id: string, name: string, offsetSec: number) => pool.query(
    `insert into teams (id, name, organization_id, created_at)
     values ($1, $2, $3, timestamp '2026-01-01 00:00:00' + ($4 || ' seconds')::interval)`,
    [id, name, ORG, offsetSec])

  const within = async () => (await pool.query(
    `select team_id, seq, within_cap from branch_entitlement
      where organization_id = $1 order by seq`, [ORG])).rows

  beforeAll(async () => {
    await mkTeam('vt_branch_t2', 'Cabang Dua', 2)
    await pool.query(`
      insert into plan_limits (plan_id, resource, cap)
      select id, 'branches', 1 from plans where is_default
      on conflict (plan_id, resource) do update set cap = 1`)
  })

  afterAll(() => restoreBranchCap())

  it('with both active, the older branch holds the only slot', async () => {
    const rows = await within()
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ team_id: 'vt_branch_t1', within_cap: true })
    expect(rows[1]).toMatchObject({ team_id: 'vt_branch_t2', within_cap: false })
  })

  it('deactivating the older branch leaves the live one operable', async () => {
    await pool.query(`
      update branch_profiles set active = false, deactivated_at = now()
       where team_id = 'vt_branch_t1'`)
    const rows = await within()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ team_id: 'vt_branch_t2', within_cap: true })
  })
})

describe('getBranchStatus: closed beats over_cap', () => {
  // Two states that are mutually exclusive at the data level -- the view has
  // no row at all for an inactive branch, so within_cap reads NULL for it.
  // That means the ORDERING of checks inside getBranchStatus can't be
  // falsified by reordering; what these tests pin is the function's actual
  // behaviour, not a provable ordering.
  const overCapBranch = `${ORG2}_over`
  const capHolderBranch = `${ORG2}_holder`

  beforeAll(async () => {
    await pool.query(`
      insert into organizations (id, name, slug, created_at)
      values ($1, 'Branch DB Test 2', 'vt-branch-2', now())`, [ORG2])
    await pool.query(`
      insert into teams (id, name, organization_id, created_at)
      values ($1, 'Holder', $2, '2026-01-01 00:00:01'::timestamp)`, [capHolderBranch, ORG2])
    await pool.query(`
      insert into teams (id, name, organization_id, created_at)
      values ($1, 'Over', $2, '2026-01-01 00:00:02'::timestamp)`, [overCapBranch, ORG2])
    await pool.query(`
      insert into plan_limits (plan_id, resource, cap)
      select id, 'branches', 1 from plans where is_default
      on conflict (plan_id, resource) do update set cap = 1`)
  })

  afterAll(() => restoreBranchCap())

  it('a deactivated branch that was over its cap position reports closed, not over_cap', async () => {
    expect(await getBranchStatus(overCapBranch, ORG2)).toBe('over_cap')
    await pool.query(`update branch_profiles set active = false where team_id = $1`, [overCapBranch])
    expect(await getBranchStatus(overCapBranch, ORG2)).toBe('closed')
  })

  // Deliberately the CAP HOLDER here, not the over-cap branch above: reusing
  // that branch would just re-prove the same clause a second time. This
  // proves the `if (!active) return 'closed'` check in getBranchStatus fires
  // unconditionally -- before within_cap is even read -- regardless of which
  // side of the cap the branch was on.
  it('a deactivated branch that held the cap slot also reports closed, not ok', async () => {
    expect(await getBranchStatus(capHolderBranch, ORG2)).toBe('ok')
    await pool.query(`update branch_profiles set active = false where team_id = $1`, [capHolderBranch])
    expect(await getBranchStatus(capHolderBranch, ORG2)).toBe('closed')
  })
})

describe('branchLabel (pure)', () => {
  it('labels a closed branch Nonaktif rather than dropping it from the switcher', () => {
    expect(branchLabel({ name: 'Cabang Lama', active: false, withinCap: true }))
      .toBe('Cabang Lama — Nonaktif')
  })
})
