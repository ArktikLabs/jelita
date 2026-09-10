import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from './db'
import {
  createCustomer, deactivateCustomer, findOrCreateByPhone, getCustomer,
  reactivateCustomer, updateCustomer,
} from '../lib/customer'
import {
  createService, deactivateService, getService, reactivateService, updateService,
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

/**
 * Task 4: the audit columns Tasks 1-3 wrote are now readable off getCustomer
 * and getService -- a name, a date, and the "diubah" suppression rule (spec
 * §5, Task 4's brief). Same "customers and services stand in for the six"
 * scope as the describe block above.
 */
describe('Task 4: getCustomer surfaces the audit trail', () => {
  it('names who created it, with nothing to report before any edit', async () => {
    const c = await createCustomer({ organizationId: ORG, name: 'Baru', actorUserId: ACTOR })
    const got = await getCustomer(c.id, ORG)
    expect(got!.audit.createdByName).toBe('Aktor Satu')
    expect(got!.audit.updatedByName).toBeNull()
  })

  it('suppresses the diubah line for the same actor updating seconds after creation', async () => {
    const c = await createCustomer({ organizationId: ORG, name: 'Baru', actorUserId: ACTOR })
    await updateCustomer(c.id, ORG, { name: 'Baru 2' }, ACTOR)
    const got = await getCustomer(c.id, ORG)
    expect(got!.audit.updatedByName).toBeNull()
  })

  it('shows the diubah line when a DIFFERENT actor makes the edit, however soon', async () => {
    const c = await createCustomer({ organizationId: ORG, name: 'Baru', actorUserId: ACTOR })
    await updateCustomer(c.id, ORG, { name: 'Baru 2' }, OTHER_ACTOR)
    const got = await getCustomer(c.id, ORG)
    expect(got!.audit.updatedByName).toBe('Aktor Dua')
  })

  it('shows the diubah line for the SAME actor once real time has passed', async () => {
    const c = await createCustomer({ organizationId: ORG, name: 'Baru', actorUserId: ACTOR })
    // Backdating created_at, not touching updated_at directly: a bare
    // UPDATE of updated_at would just be overwritten by touch_updated_at
    // (Task 1's trigger) the moment the row is next written.
    await pool.query(
      `update customers set created_at = now() - interval '1 hour' where id = $1`, [c.id])
    await updateCustomer(c.id, ORG, { name: 'Baru 2' }, ACTOR)
    const got = await getCustomer(c.id, ORG)
    expect(got!.audit.updatedByName).toBe('Aktor Satu')
  })

  it('shows the deactivation line even when there was no content edit at all', async () => {
    const c = await createCustomer({ organizationId: ORG, name: 'Baru', actorUserId: ACTOR })
    await deactivateCustomer(c.id, ORG, OTHER_ACTOR)
    const got = await getCustomer(c.id, ORG)
    expect(got!.audit.deletedByName).toBe('Aktor Dua')
    // deactivateCustomer deliberately does not touch updated_by (Task 3) --
    // a "last touched by" reading only updated_by would miss this event.
    expect(got!.audit.updatedByName).toBeNull()
  })

  it("renders a public-booking customer's null creator as no name, never a broken join guessing at one", async () => {
    const found = await findOrCreateByPhone(
      ORG, { name: 'Publik', phone: '081200000099', actorUserId: null })
    const got = await getCustomer(found.id, ORG)
    // The page omits the created line entirely for a null createdByName --
    // it cannot tell this row apart from one the seed script inserted
    // directly, so no fallback text is honest here (see the page).
    expect(got!.audit.createdByName).toBeNull()
  })
})

describe('Task 4: getService surfaces the audit trail', () => {
  const create = (actorUserId: string) => createService({
    organizationId: ORG, name: `Audit Svc ${crypto.randomUUID()}`,
    durationMinutes: 30, price: 50000, currency: 'IDR', actorUserId,
  })

  it('suppresses the diubah line for the immediate same-actor update', async () => {
    const created = await create(ACTOR)
    await updateService(
      created!.id, ORG,
      { name: `Diubah ${crypto.randomUUID()}`, categoryId: null, durationMinutes: 45, price: 60000 },
      ACTOR)
    const got = await getService(created!.id, ORG)
    expect(got!.audit.updatedByName).toBeNull()
  })

  it('shows the diubah line for a different actor', async () => {
    const created = await create(ACTOR)
    await updateService(
      created!.id, ORG,
      { name: `Diubah ${crypto.randomUUID()}`, categoryId: null, durationMinutes: 45, price: 60000 },
      OTHER_ACTOR)
    const got = await getService(created!.id, ORG)
    expect(got!.audit.updatedByName).toBe('Aktor Dua')
  })

  it('shows the deactivation line, independent of the diubah line', async () => {
    const created = await create(ACTOR)
    await deactivateService(created!.id, ORG, OTHER_ACTOR)
    const got = await getService(created!.id, ORG)
    expect(got!.audit.deletedByName).toBe('Aktor Dua')
    expect(got!.audit.updatedByName).toBeNull()
  })
})
