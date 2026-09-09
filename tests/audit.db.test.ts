import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from './db'
import {
  createCustomer, deactivateCustomer, reactivateCustomer, updateCustomer,
} from '../lib/customer'
import {
  createService, deactivateService, reactivateService, updateService,
} from '../lib/service'

/**
 * The audit columns, asserted against real Postgres. These are schema
 * guarantees, so only the database can confirm them.
 */
const pool = new Pool({ connectionString: TEST_DATABASE_URL })
const ORG = 'audit_org'
const ACTOR = 'audit_actor_1'
const OTHER_ACTOR = 'audit_actor_2'

const columns = async (table: string) => (await pool.query(
  `select column_name from information_schema.columns
    where table_schema='public' and table_name=$1`, [table])).rows.map((r) => r.column_name)

beforeAll(async () => {
  await pool.query(`delete from organizations where id = $1`, [ORG])
  await pool.query(
    `insert into organizations (id, name, slug, created_at) values ($1, 'Audit', 'audit-org', now())`,
    [ORG])
  await pool.query(
    `insert into users (id, name, email, email_verified, created_at, updated_at)
     values ($1, 'Aktor Satu', 'audit1@audit.local', true, now(), now()),
            ($2, 'Aktor Dua', 'audit2@audit.local', true, now(), now())`,
    [ACTOR, OTHER_ACTOR])
})
afterAll(async () => {
  await pool.query(`delete from organizations where id = $1`, [ORG])
  await pool.query(`delete from users where id = any($1)`, [[ACTOR, OTHER_ACTOR]])
  await pool.end()
})

describe('the audit columns exist where they should', () => {
  for (const t of ['customers', 'products', 'services']) {
    it(`${t} carries all four`, async () => {
      const cols = await columns(t)
      for (const c of ['created_by', 'updated_by', 'deleted_at', 'deleted_by']) {
        expect(cols, `${t}.${c}`).toContain(c)
      }
    })
  }

  for (const t of ['staff_profiles', 'branch_profiles']) {
    it(`${t} was renamed, not doubled`, async () => {
      const cols = await columns(t)
      expect(cols).toContain('deleted_at')
      expect(cols).toContain('deleted_by')
      // The rename must REPLACE the old name. Two columns for one concept is
      // the drift this phase exists to end.
      expect(cols, 'deactivated_at must be gone').not.toContain('deactivated_at')
    })
  }

  it('transactions carries created_by and NOT updated_by', async () => {
    const cols = await columns('transactions')
    expect(cols).toContain('created_by')
    // Settled rows are immutable by trigger, so updated_by could never be
    // written. A column that can never be written is a lie in the schema.
    expect(cols).not.toContain('updated_by')
  })
})

describe('updated_at maintains itself', () => {
  it('moves on update without the caller setting it', async () => {
    // 31 sites set `updated_at = now()` by hand today and nothing enforced it.
    // The trigger is what makes the column trustworthy.
    await pool.query(
      `insert into customers (id, organization_id, name) values ('audit_c1', $1, 'Awal')`, [ORG])
    const { rows: [before] } = await pool.query(
      `select updated_at from customers where id = 'audit_c1'`)
    await pool.query(`select pg_sleep(0.01)`)
    await pool.query(`update customers set name = 'Diubah' where id = 'audit_c1'`)
    const { rows: [after] } = await pool.query(
      `select updated_at from customers where id = 'audit_c1'`)
    expect(new Date(after.updated_at).getTime())
      .toBeGreaterThan(new Date(before.updated_at).getTime())
  })
})

describe('the actor columns reference a real user', () => {
  it('refuses an actor who does not exist', async () => {
    await expect(pool.query(
      `insert into customers (id, organization_id, name, created_by)
       values ('audit_c2', $1, 'Palsu', 'no-such-user')`, [ORG]))
      .rejects.toThrow(/foreign key|violates/i)
  })

  it('allows a NULL actor, which means "not a signed-in person"', async () => {
    // A public booking, the seed and the cron all write without a session.
    await expect(pool.query(
      `insert into customers (id, organization_id, name, created_by)
       values ('audit_c3', $1, 'Publik', null)`, [ORG])).resolves.toBeDefined()
  })
})

/**
 * The actor threaded through the write paths themselves (Task 2), not just
 * the columns Task 1 added. customers and services stand in for the six --
 * same shape as staff and branches (lib/staff.ts, lib/branch.ts), which
 * follow the identical create/update/deactivate/reactivate pattern.
 */
describe('customers: the actor threaded through create/update/deactivate', () => {
  it('records who created it', async () => {
    const c = await createCustomer({ organizationId: ORG, name: 'Baru', actorUserId: ACTOR })
    const { rows: [row] } = await pool.query(
      `select created_by, updated_by from customers where id = $1`, [c.id])
    expect(row.created_by).toBe(ACTOR)
    // created_by is set on insert and never touched again; updated_by is null
    // until someone actually changes the row, so the two are distinguishable.
    expect(row.updated_by).toBeNull()
  })

  it('records who changed it, without disturbing who created it', async () => {
    const c = await createCustomer({ organizationId: ORG, name: 'Baru', actorUserId: ACTOR })
    await updateCustomer(c.id, ORG, { name: 'Diubah' }, OTHER_ACTOR)
    const { rows: [row] } = await pool.query(
      `select created_by, updated_by from customers where id = $1`, [c.id])
    expect(row.created_by).toBe(ACTOR)
    expect(row.updated_by).toBe(OTHER_ACTOR)
  })

  it('records who deactivated it, and leaves active as the truth', async () => {
    const c = await createCustomer({ organizationId: ORG, name: 'Baru', actorUserId: ACTOR })
    await deactivateCustomer(c.id, ORG, ACTOR)
    const { rows: [row] } = await pool.query(
      `select active, deleted_at, deleted_by from customers where id = $1`, [c.id])
    expect(row.active).toBe(false)
    expect(row.deleted_at).not.toBeNull()
    expect(row.deleted_by).toBe(ACTOR)
  })

  it('clears the deactivation stamp on reactivation', async () => {
    // Reactivation is a first-class feature here (branches, services, staff
    // all have it). A row that is live again must not still claim a
    // deletion date.
    const c = await createCustomer({ organizationId: ORG, name: 'Baru', actorUserId: ACTOR })
    await deactivateCustomer(c.id, ORG, ACTOR)
    await reactivateCustomer(c.id, ORG, OTHER_ACTOR)
    const { rows: [row] } = await pool.query(
      `select active, deleted_at, deleted_by from customers where id = $1`, [c.id])
    expect(row.active).toBe(true)
    expect(row.deleted_at).toBeNull()
    expect(row.deleted_by).toBeNull()
  })
})

describe('services: the actor threaded through create/update/deactivate', () => {
  const create = (actorUserId: string) => createService({
    organizationId: ORG, name: `Layanan ${crypto.randomUUID()}`,
    durationMinutes: 30, price: 50000, currency: 'IDR', actorUserId,
  })

  it('records who created it', async () => {
    const created = await create(ACTOR)
    const { rows: [row] } = await pool.query(
      `select created_by, updated_by from services where id = $1`, [created!.id])
    expect(row.created_by).toBe(ACTOR)
    expect(row.updated_by).toBeNull()
  })

  it('records who changed it, without disturbing who created it', async () => {
    const created = await create(ACTOR)
    await updateService(
      created!.id, ORG,
      { name: 'Diubah', categoryId: null, durationMinutes: 45, price: 60000 },
      OTHER_ACTOR,
    )
    const { rows: [row] } = await pool.query(
      `select created_by, updated_by from services where id = $1`, [created!.id])
    expect(row.created_by).toBe(ACTOR)
    expect(row.updated_by).toBe(OTHER_ACTOR)
  })

  it('records who deactivated it, and leaves active as the truth', async () => {
    const created = await create(ACTOR)
    await deactivateService(created!.id, ORG, ACTOR)
    const { rows: [row] } = await pool.query(
      `select active, deleted_at, deleted_by from services where id = $1`, [created!.id])
    expect(row.active).toBe(false)
    expect(row.deleted_at).not.toBeNull()
    expect(row.deleted_by).toBe(ACTOR)
  })

  it('clears the deactivation stamp on reactivation', async () => {
    const created = await create(ACTOR)
    await deactivateService(created!.id, ORG, ACTOR)
    await reactivateService(created!.id, ORG, OTHER_ACTOR)
    const { rows: [row] } = await pool.query(
      `select active, deleted_at, deleted_by from services where id = $1`, [created!.id])
    expect(row.active).toBe(true)
    expect(row.deleted_at).toBeNull()
    expect(row.deleted_by).toBeNull()
  })
})
