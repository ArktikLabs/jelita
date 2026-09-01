import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from './db'

/**
 * Constraint behaviour, asserted against a real Postgres rather than mocked.
 * These are the guarantees booking will rely on for deterministic dedup, and
 * they live in the schema, so only the database can confirm them.
 */
const pool = new Pool({ connectionString: TEST_DATABASE_URL })
const ORG = 'vt_cust_org'
const ORG2 = 'vt_cust_org2'

const addCustomer = (id: string, org: string, name: string, key: string | null) =>
  pool.query(
    `insert into customers (id, organization_id, name, phone_key) values ($1, $2, $3, $4)`,
    [id, org, name, key])

beforeAll(async () => {
  await pool.query(`delete from organizations where id = any($1)`, [[ORG, ORG2]])
  await pool.query(`
    insert into organizations (id, name, slug, created_at)
    values ($1, 'VT Cust', 'vt-cust', now()), ($2, 'VT Cust 2', 'vt-cust-2', now())`,
    [ORG, ORG2])
})

afterAll(async () => {
  await pool.query(`delete from organizations where id = any($1)`, [[ORG, ORG2]])
  await pool.end()
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
