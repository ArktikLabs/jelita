import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from './db'
import { PRODUCT_LIST, listProducts } from '../lib/inventory'
import { SERVICE_LIST, listServices } from '../lib/service'
import { STAFF_LIST, listStaff } from '../lib/staff'
import { BRANCH_LIST, listBranches } from '../lib/branch'
import { TRANSACTION_LIST, listSales } from '../lib/pos'
import { exportQuery } from '../lib/list-query'

/**
 * §8's export, proven tenant-scoped against real Postgres -- one test per
 * resource, for the five Task 3 adds (products, services, staff, branches,
 * transactions; customers' own export is already proven at the e2e layer,
 * tests/e2e/customers.spec.ts).
 *
 * Each assertion names a row belonging to the OTHER salon and proves it is
 * ABSENT -- not only that the expected row is present. A query missing its
 * organization_id predicate would still pass an assertion that only checks
 * presence, which is exactly the leak this file exists to catch.
 */
const pool = new Pool({ connectionString: TEST_DATABASE_URL })

const ORG = 'csvx_org'
const ORG2 = 'csvx_org2'
const TEAM = 'csvx_team'
const TEAM2 = 'csvx_team2'
const STAFF_A = 'csvx_staff_a'
const STAFF_B = 'csvx_staff_b'
const CUSTOMER_A = 'csvx_customer_a'
const CUSTOMER_B = 'csvx_customer_b'

beforeAll(async () => {
  await pool.query(`delete from organizations where id = any($1)`, [[ORG, ORG2]])
  await pool.query(`delete from users where id = any($1)`, [[STAFF_A, STAFF_B]])
  await pool.query(`
    insert into organizations (id, name, slug, created_at)
    values ($1, 'CSV Salon Kita', 'csvx-salon', now()),
           ($2, 'CSV Salon Lain', 'csvx-salon-lain', now())`,
    [ORG, ORG2])
  await pool.query(`
    insert into teams (id, name, organization_id, created_at)
    values ($1, 'Cabang Kita', $2, now()), ($3, 'Cabang Lain', $4, now())`,
    [TEAM, ORG, TEAM2, ORG2])

  for (const [id, org, name] of [
    [STAFF_A, ORG, 'Nita Milik Kita'], [STAFF_B, ORG2, 'Nita Salon Lain'],
  ] as const) {
    await pool.query(`
      insert into users (id, name, email, email_verified, created_at, updated_at)
      values ($1, $2, $1 || '@csvx.local', true, now(), now())`, [id, name])
    await pool.query(`
      insert into members (id, user_id, organization_id, role, created_at)
      values ($1 || '_m', $1, $2, 'stylist', now())`, [id, org])
  }

  await pool.query(`
    insert into products (id, organization_id, name, kind, price)
    values ('csvx_product_a', $1, 'Sampo Milik Kita', 'retail', 20000),
           ('csvx_product_b', $2, 'Sampo Salon Lain', 'retail', 20000)`, [ORG, ORG2])

  await pool.query(`
    insert into services (id, organization_id, name, duration_minutes, price)
    values ('csvx_service_a', $1, 'Potong Milik Kita', 30, 50000),
           ('csvx_service_b', $2, 'Potong Salon Lain', 30, 50000)`, [ORG, ORG2])

  await pool.query(`
    insert into customers (id, organization_id, name)
    values ($1, $2, 'Sari Wijaya'), ($3, $4, 'Outsider Customer')`,
    [CUSTOMER_A, ORG, CUSTOMER_B, ORG2])

  await pool.query(`
    insert into transactions (id, organization_id, team_id, customer_id, status,
                              subtotal, discount, total, currency, completed_at)
    values ('csvx_txn_a', $1, $2, $3, 'completed', 100000, 0, 100000, 'IDR', now()),
           ('csvx_txn_b', $4, $5, $6, 'completed', 100000, 0, 100000, 'IDR', now())`,
    [ORG, TEAM, CUSTOMER_A, ORG2, TEAM2, CUSTOMER_B])
})

afterAll(async () => {
  await pool.query(`truncate transaction_payments, transaction_lines, transactions cascade`)
  await pool.query(`delete from organizations where id = any($1)`, [[ORG, ORG2]])
  await pool.query(`delete from users where id = any($1)`, [[STAFF_A, STAFF_B]])
  await pool.end()
})

describe('the CSV export never crosses tenants', () => {
  it('products: never exports another salon\'s rows', async () => {
    const { rows } = await listProducts(ORG, TEAM, exportQuery(PRODUCT_LIST, {}))
    const names = rows.map((r) => r.name)
    expect(names).toContain('Sampo Milik Kita')
    expect(names, 'the other salon\'s product').not.toContain('Sampo Salon Lain')
  })

  it('services: never exports another salon\'s rows', async () => {
    const { rows } = await listServices(ORG, exportQuery(SERVICE_LIST, {}))
    const names = rows.map((r) => r.name)
    expect(names).toContain('Potong Milik Kita')
    expect(names, 'the other salon\'s service').not.toContain('Potong Salon Lain')
  })

  it('staff: never exports another salon\'s rows', async () => {
    const { rows } = await listStaff(ORG, exportQuery(STAFF_LIST, {}))
    const names = rows.map((r) => r.name)
    expect(names).toContain('Nita Milik Kita')
    expect(names, 'the other salon\'s staff').not.toContain('Nita Salon Lain')
  })

  it('branches: never exports another salon\'s rows', async () => {
    const { rows } = await listBranches(ORG, exportQuery(BRANCH_LIST, {}))
    const names = rows.map((r) => r.name)
    expect(names).toContain('Cabang Kita')
    expect(names, 'the other salon\'s branch').not.toContain('Cabang Lain')
  })

  it('transactions: never exports another salon\'s rows', async () => {
    const { rows } = await listSales(ORG, TEAM, exportQuery(TRANSACTION_LIST, {}))
    const names = rows.map((r) => r.customerName)
    expect(names).toContain('Sari Wijaya')
    expect(names, 'the other salon\'s transaction').not.toContain('Outsider Customer')
  })
})
