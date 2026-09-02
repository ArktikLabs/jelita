import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from './db'
import { PLANS } from '../scripts/seed-plans.mjs'
import { CAPPED_RESOURCES, FEATURE_KEYS } from '../lib/plan/catalog'

/**
 * Plan schema, constraints, triggers and catalogue integrity -- asserted
 * against a real Postgres rather than mocked, same reasoning as
 * customers.db.test.ts. Entitlement resolution and quota enforcement driven
 * over HTTP live in tests/e2e/plan.spec.ts instead.
 */
const pool = new Pool({ connectionString: TEST_DATABASE_URL })
const FREE = PLANS.find((p) => p.key === 'free')!
const ORG = 'vt_plan_org'
const BORG = 'vt_plan_branch_org'
const PAID_KEY = 'vt_plan_paid'

// lib/plan/branch.ts reads its pool from process.env.DATABASE_URL
// (lib/pg-pool.ts). Point it at the disposable database before importing --
// otherwise it inherits whatever DATABASE_URL is already set to (Supabase in
// .env.local, or nothing at all).
process.env.DATABASE_URL = TEST_DATABASE_URL
const { getBranchStatus } = await import('../lib/plan/branch')

// Restore from the seed export, never from the live table: reading the live
// value after a crashed run is what would launder a corrupted cap forward.
const restoreFreeCap = (resource: 'branches' | 'staff') => pool.query(`
  insert into plan_limits (plan_id, resource, cap)
  select id, $1, $2 from plans where key = 'free'
  on conflict (plan_id, resource) do update set cap = excluded.cap`,
  [resource, FREE.caps[resource as 'branches' | 'staff']])

beforeAll(async () => {
  await pool.query(`delete from organizations where id = any($1)`, [[ORG, BORG]])
  await pool.query(`delete from plans where key = $1`, [PAID_KEY])
})

afterAll(async () => {
  await pool.query(`delete from organizations where id = any($1)`, [[ORG, BORG]])
  await pool.query(`delete from plans where key = $1`, [PAID_KEY])
  await restoreFreeCap('branches')
  await restoreFreeCap('staff')
  await pool.end()
})

describe('schema', () => {
  it('all five plan tables exist', async () => {
    const { rows } = await pool.query(`
      select table_name from information_schema.tables
       where table_schema = 'public'
         and table_name in ('features','plans','plan_limits','plan_features','subscriptions')
       order by table_name`)
    expect(rows.map((r) => r.table_name)).toHaveLength(5)
  })

  it('RLS is enabled on all plan tables', async () => {
    const { rows } = await pool.query(`
      select c.relname, c.relrowsecurity
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relname in ('features','plans','plan_limits','plan_features','subscriptions')`)
    expect(rows).toHaveLength(5)
    expect(rows.every((r) => r.relrowsecurity === true)).toBe(true)
  })
})

describe('constraints', () => {
  it('refuses a second is_default plan', async () => {
    await expect(pool.query(`
      insert into plans (key, name, is_default) values ('vt_plan_dup_default', 'Dup', true)`))
      .rejects.toThrow()
    await pool.query(`delete from plans where key = 'vt_plan_dup_default'`)
  })

  it('refuses an unknown plan_limits resource', async () => {
    await expect(pool.query(`
      insert into plan_limits (plan_id, resource, cap)
      select id, 'nonsense', 1 from plans where is_default`))
      .rejects.toThrow()
  })

  it('refuses a branches cap of 0 (it would break signup mid-write)', async () => {
    // A branches cap of 0 would fail signup after the organization and owner
    // rows commit and before the default team, leaving an orphan salon.
    // Attempted in a transaction that always rolls back, so a regression
    // cannot corrupt the cap for later tests.
    const c = await pool.connect()
    try {
      await c.query('begin')
      await expect(c.query(`
        update plan_limits set cap = 0
         where resource = 'branches' and plan_id = (select id from plans where is_default)`))
        .rejects.toThrow()
    } finally {
      await c.query('rollback').catch(() => {})
      c.release()
    }
  })
})

describe('default plan trigger', () => {
  it('auto-subscribes a new organization to the default plan', async () => {
    await pool.query(`
      insert into organizations (id, name, slug, created_at)
      values ($1, 'Plan Test', 'vt-plan', now())`, [ORG])
    const { rows } = await pool.query(`
      select s.status, p.key from subscriptions s
        join plans p on p.id = s.plan_id
       where s.organization_id = $1`, [ORG])
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('active')
    expect(rows[0].key).toBe('free')
  })
})

describe('branch lock rule', () => {
  // Branches 1 and 2 get a literal, byte-identical created_at: now() is
  // transaction_timestamp() and each pool.query is its own transaction, so
  // two now() calls differ by milliseconds and the view's `, t.id` tiebreak
  // would never actually decide anything.
  const mkTeam = (id: number, n: string, at: string) => pool.query(
    `insert into teams (id, name, organization_id, created_at)
     values ($1, $2, $3, $4::timestamp)`,
    [`vt_plan_t${id}`, n, ORG, at])

  const capTo = (n: number) => pool.query(`
    insert into plan_limits (plan_id, resource, cap)
    select id, 'branches', $1 from plans where is_default
    on conflict (plan_id, resource) do update set cap = excluded.cap`, [n])

  beforeAll(async () => {
    await mkTeam(1, 'Branch 1', '2026-01-01 00:00:01')
    await mkTeam(2, 'Branch 2', '2026-01-01 00:00:01')
    await mkTeam(3, 'Branch 3', '2026-01-01 00:00:02')
  })

  afterAll(() => restoreFreeCap('branches'))

  it('only the oldest branch stays active at cap 1', async () => {
    await capTo(1)
    const { rows } = await pool.query(`
      select team_id, seq, within_cap from branch_entitlement
       where organization_id = $1 order by seq`, [ORG])
    expect(rows).toHaveLength(3)
    expect(rows[0].within_cap).toBe(true)
    expect(rows[1].within_cap).toBe(false)
    expect(rows[2].within_cap).toBe(false)
  })

  it('the (created_at, id) tiebreak gives the lower id the surviving seat', async () => {
    // t1 and t2 share a created_at exactly, so the lower id must take seq 1
    // and the other must be the locked one.
    const { rows } = await pool.query(`
      select team_id from branch_entitlement
       where organization_id = $1 order by seq`, [ORG])
    expect(rows.map((r) => r.team_id)).toEqual(['vt_plan_t1', 'vt_plan_t2', 'vt_plan_t3'])
  })

  it('raising the cap re-activates every branch with no manual unlock', async () => {
    await capTo(3)
    const { rows } = await pool.query(`
      select within_cap from branch_entitlement where organization_id = $1`, [ORG])
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.within_cap === true)).toBe(true)
  })
})

describe('effective_plan resolves subscription status', () => {
  // Only the 'free' default plan has existed so far, so subscriptions.plan_id
  // has necessarily always equaled plans.id where is_default -- a broken
  // effective_plan that ignores status entirely would pass the same way a
  // correct one does. Give the org a distinct non-default plan so canceled
  // vs. non-canceled resolve to visibly different ids.
  beforeAll(async () => {
    await pool.query(`insert into plans (key, name) values ($1, 'Plan Test Paid')`, [PAID_KEY])
    const { rows: paid } = await pool.query(`select id from plans where key = $1`, [PAID_KEY])
    await pool.query(`
      update subscriptions set plan_id = $1, status = 'active'
       where organization_id = $2`, [paid[0].id, ORG])
  })

  afterAll(async () => {
    // subscriptions.plan_id has ON DELETE no action -- point the org back at
    // the default plan before the paid one is torn down, or the delete fails.
    await pool.query(`
      update subscriptions set plan_id = (select id from plans where is_default), status = 'active'
       where organization_id = $1`, [ORG])
    await pool.query(`delete from plans where key = $1`, [PAID_KEY])
  })

  it('canceled resolves to the default plan (not the subscribed plan)', async () => {
    await pool.query(`update subscriptions set status = 'canceled' where organization_id = $1`, [ORG])
    const { rows: [cancelled] } = await pool.query(`
      select plan_id from effective_plan where organization_id = $1`, [ORG])
    const { rows: [def] } = await pool.query(`select id from plans where is_default`)
    const { rows: [paid] } = await pool.query(`select id from plans where key = $1`, [PAID_KEY])
    expect(String(cancelled.plan_id)).toBe(String(def.id))
    expect(String(cancelled.plan_id)).not.toBe(String(paid.id))
  })

  it('past_due retains the subscribed plan, not the default', async () => {
    await pool.query(`update subscriptions set status = 'past_due' where organization_id = $1`, [ORG])
    const { rows: [pastDue] } = await pool.query(`
      select plan_id from effective_plan where organization_id = $1`, [ORG])
    const { rows: [def] } = await pool.query(`select id from plans where is_default`)
    const { rows: [paid] } = await pool.query(`select id from plans where key = $1`, [PAID_KEY])
    expect(String(pastDue.plan_id)).toBe(String(paid.id))
    expect(String(pastDue.plan_id)).not.toBe(String(def.id))
  })
})

describe('catalog integrity', () => {
  it('every TS feature key exists in the features table', async () => {
    const { rows } = await pool.query(`select key from features`)
    const dbKeys = rows.map((r) => r.key)
    const missing = FEATURE_KEYS.filter((k) => !dbKeys.includes(k))
    expect(missing).toEqual([])
  })

  it('every features row exists in the TS catalog', async () => {
    const { rows } = await pool.query(`select key from features`)
    const dbKeys = rows.map((r) => r.key)
    const orphaned = dbKeys.filter((k) => !(FEATURE_KEYS as readonly string[]).includes(k))
    expect(orphaned).toEqual([])
  })

  it('deleting a feature a plan still sells is refused', async () => {
    // In a transaction that is always rolled back: if the FK ever stops
    // restricting, the bare delete would succeed and take the payroll row
    // with it, breaking this whole section on every later run.
    const c = await pool.connect()
    try {
      await c.query('begin')
      await expect(c.query(`delete from features where key = 'payroll'`)).rejects.toThrow()
    } finally {
      await c.query('rollback').catch(() => {})
      c.release()
    }
  })

  it('CAPPED_RESOURCES matches the plan_limits_resource CHECK exactly', async () => {
    const { rows: [{ constraintdef }] } = await pool.query(`
      select pg_get_constraintdef(oid) as constraintdef
        from pg_constraint where conname = 'plan_limits_resource'`)
    const checkResources = [...(constraintdef as string).matchAll(/'([a-z_]+)'/g)]
      .map((m) => m[1]).sort()
    expect(checkResources).toEqual([...CAPPED_RESOURCES].sort())
  })

  it('four tiers are seeded', async () => {
    const { rows: [{ n }] } = await pool.query(`select count(*)::int n from plans`)
    expect(n).toBe(4)
  })
})

describe('getBranchStatus() -- the function requireBranch actually calls', () => {
  // Section "branch lock rule" above already proves the branch_entitlement
  // VIEW's lock rule directly. This proves the getBranchStatus() FUNCTION
  // that requireBranch depends on, via a real import rather than another
  // direct query, against its own org and teams.
  const branch1 = `${BORG}_b1`
  const branch2 = `${BORG}_b2`

  beforeAll(async () => {
    await pool.query(`
      insert into organizations (id, name, slug, created_at)
      values ($1, 'Plan Branch Test', 'vt-plan-branch', now())`, [BORG])
    await pool.query(`
      insert into teams (id, name, organization_id, created_at)
      values ($1, 'Branch A', $2, '2026-01-01 00:00:01'::timestamp)`, [branch1, BORG])
    await pool.query(`
      insert into teams (id, name, organization_id, created_at)
      values ($1, 'Branch B', $2, '2026-01-01 00:00:02'::timestamp)`, [branch2, BORG])
    await pool.query(`
      update subscriptions set plan_id = (select id from plans where key = 'pro')
       where organization_id = $1`, [BORG])
  })

  it('is ok for branches within the cap (pro, both branches)', async () => {
    const statuses = [await getBranchStatus(branch1, BORG), await getBranchStatus(branch2, BORG)]
    expect(statuses).toEqual(['ok', 'ok'])
  })

  it('is over_cap for the newer branch after a downgrade', async () => {
    await pool.query(`
      update subscriptions set plan_id = (select id from plans where key = 'free')
       where organization_id = $1`, [BORG])
    const statuses = [await getBranchStatus(branch1, BORG), await getBranchStatus(branch2, BORG)]
    expect(statuses).toEqual(['ok', 'over_cap'])
  })

  it('is ok again after raising the cap, no manual unlock', async () => {
    await pool.query(`
      update subscriptions set plan_id = (select id from plans where key = 'pro')
       where organization_id = $1`, [BORG])
    expect(await getBranchStatus(branch2, BORG)).toBe('ok')
  })

  it('is ok for an unknown branch id (let other layers 404 it)', async () => {
    expect(await getBranchStatus('vt-plan-nonexistent-branch-id', BORG)).toBe('ok')
  })
})
