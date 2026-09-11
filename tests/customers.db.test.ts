import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from './db'
import { deactivateCustomer, listCustomers, CUSTOMER_LIST } from '../lib/customer'
import { parseListQuery } from '../lib/list-query'

/**
 * Constraint behaviour, asserted against a real Postgres rather than mocked.
 * These are the guarantees booking will rely on for deterministic dedup, and
 * they live in the schema, so only the database can confirm them.
 */
const pool = new Pool({ connectionString: TEST_DATABASE_URL })
const ORG = 'vt_cust_org'
const ORG2 = 'vt_cust_org2'
const ACTOR = 'vt_cust_actor'

const addCustomer = (id: string, org: string, name: string, key: string | null) =>
  pool.query(
    `insert into customers (id, organization_id, name, phone_key) values ($1, $2, $3, $4)`,
    [id, org, name, key])

beforeAll(async () => {
  await pool.query(`delete from organizations where id = any($1)`, [[ORG, ORG2]])
  await pool.query(`delete from users where id = $1`, [ACTOR])
  await pool.query(`
    insert into organizations (id, name, slug, created_at)
    values ($1, 'VT Cust', 'vt-cust', now()), ($2, 'VT Cust 2', 'vt-cust-2', now())`,
    [ORG, ORG2])
  await pool.query(`
    insert into users (id, name, email, email_verified, created_at, updated_at)
    values ($1, 'VT Cust Actor', 'vt-cust-actor@vt.local', true, now(), now())`, [ACTOR])
})

afterAll(async () => {
  await pool.query(`delete from users where id = $1`, [ACTOR])
  await pool.query(`delete from organizations where id = any($1)`, [[ORG, ORG2]])
  await pool.end()
})

describe('schema', () => {
  it('the partial phone index exists', async () => {
    const { rows } = await pool.query(`
      select indexname from pg_indexes where tablename = 'customers'`)
    expect(rows.map((r) => r.indexname)).toContain('customers_org_phone_key')
  })

  it('RLS is enabled', async () => {
    const { rows: [row] } = await pool.query(`
      select relrowsecurity from pg_class where relname = 'customers'`)
    expect(row.relrowsecurity).toBe(true)
  })
})

describe('customers phone uniqueness', () => {
  it('refuses a second customer with the same number in one salon', async () => {
    await addCustomer('vt_c1', ORG, 'Dewi', '62812345678')
    await expect(addCustomer('vt_c2', ORG, 'Dewi Lagi', '62812345678')).rejects.toThrow(
      /customers_org_phone_key/)
  })

  it('allows many customers with no number', async () => {
    // Not because the index is partial -- Postgres treats NULLs as distinct in
    // a unique index regardless. Asserted because the BEHAVIOUR is what a cash
    // walk-in depends on, whatever enforces it.
    await addCustomer('vt_c3', ORG, 'Walk-in Satu', null)
    await expect(addCustomer('vt_c4', ORG, 'Walk-in Dua', null)).resolves.toBeDefined()
  })

  it('scopes uniqueness per salon', async () => {
    await expect(addCustomer('vt_c5', ORG2, 'Dewi Salon Lain', '62812345678'))
      .resolves.toBeDefined()
  })
})

/**
 * Fix 5 (phase 4 review): the bulk action discarded deactivateCustomer's
 * result with `.then(() => true)`, so an id from another org (or one that
 * never existed) reported "1 dinonaktifkan" having changed nothing --
 * branches and staff already re-read to tell a real update from a no-op
 * (lib/branch.ts, lib/staff.ts); customers must be equally honest.
 */
describe('deactivateCustomer', () => {
  it('reports true when it actually deactivated the row', async () => {
    await addCustomer('vt_c_deact_1', ORG, 'Deact Satu', null)
    const closed = await deactivateCustomer('vt_c_deact_1', ORG, ACTOR)
    expect(closed).toBe(true)
    const { rows: [row] } = await pool.query(`select active from customers where id = $1`,
      ['vt_c_deact_1'])
    expect(row.active).toBe(false)
  })

  it("reports false for another salon's customer -- and never touches the row", async () => {
    await addCustomer('vt_c_deact_2', ORG2, 'Deact Salon Lain', null)
    const closed = await deactivateCustomer('vt_c_deact_2', ORG, ACTOR)
    expect(closed).toBe(false)
    const { rows: [row] } = await pool.query(`select active from customers where id = $1`,
      ['vt_c_deact_2'])
    expect(row.active).toBe(true)
  })

  it('reports false for an id that never existed', async () => {
    const closed = await deactivateCustomer('vt_c_deact_nonexistent', ORG, ACTOR)
    expect(closed).toBe(false)
  })
})

describe('listCustomers paging', () => {
  const q = (params: Record<string, string> = {}) => parseListQuery(CUSTOMER_LIST, params)

  beforeAll(async () => {
    await pool.query(`delete from customers where organization_id = $1`, [ORG])
    // 60 rows, and DELIBERATELY duplicated names: a non-unique sort column is
    // what makes paging non-deterministic without a tiebreaker.
    for (let i = 0; i < 60; i++) {
      await pool.query(
        `insert into customers (id, organization_id, name, phone, phone_key)
         values ($1, $2, $3, $4, $5)`,
        [`pg_${String(i).padStart(3, '0')}`, ORG, 'Sama Persis', `08120000${String(i).padStart(3, '0')}`,
         `628120000${String(i).padStart(3, '0')}`])
    }
  })

  it('returns one page and the true total', async () => {
    const r = await listCustomers(ORG, q())
    expect(r.rows).toHaveLength(25)
    expect(r.total).toBe(60)
    expect(r.pages).toBe(3)
    expect(r.page).toBe(1)
  })

  it('pages through 60 identical names without repeating or losing one', async () => {
    // This proves paging returns every row of THIS dataset exactly once. It
    // does NOT prove the tiebreaker is present: Postgres's tie order for an
    // unchanging small table tends to be stable run-to-run even with no
    // tiebreak at all, so a missing tiebreak does not reliably fail this
    // test (confirmed by breaking it -- see tests/list-query.test.ts's
    // `orderBy` suite, which asserts the emitted ORDER BY text directly and
    // is what actually proves §3.3).
    const seen = new Set<string>()
    for (const page of ['1', '2', '3']) {
      const r = await listCustomers(ORG, q({ page }))
      for (const row of r.rows) seen.add(row.id)
    }
    expect(seen.size, 'every row seen exactly once across three pages').toBe(60)
  })

  it('clamps a page past the end to the last page', async () => {
    const r = await listCustomers(ORG, q({ page: '999' }))
    expect(r.page).toBe(3)
    expect(r.rows).toHaveLength(10)
  })

  it('counts only the rows the search matches', async () => {
    const r = await listCustomers(ORG, q({ q: '628120000005' }))
    expect(r.total).toBe(1)
    expect(r.rows).toHaveLength(1)
  })

  it('sorts descending when asked', async () => {
    const asc = await listCustomers(ORG, q({ sort: 'created' }))
    const desc = await listCustomers(ORG, q({ sort: '-created' }))
    expect(desc.rows[0].id).not.toBe(asc.rows[0].id)
  })

  it('never returns another salon"s customers', async () => {
    await pool.query(
      `insert into customers (id, organization_id, name) values ('pg_other', $1, 'Sama Persis')`,
      [ORG2])
    const r = await listCustomers(ORG, q())
    expect(r.total).toBe(60)
    expect(r.rows.map((x) => x.id)).not.toContain('pg_other')
  })
})
