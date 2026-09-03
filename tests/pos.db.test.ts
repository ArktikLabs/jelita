import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from './db'

/**
 * The POS ledger's guarantees, asserted against real Postgres.
 *
 * These go straight at the constraints and triggers, not through the app:
 * "immutable after completion" is only worth anything if it holds against a
 * direct statement, which is exactly what a report, a migration or an admin
 * fix at 2am will be.
 */
const pool = new Pool({ connectionString: TEST_DATABASE_URL })

const ORG = 'pos_org'
const ORG2 = 'pos_org2'
const TEAM = 'pos_team'
const TEAM2 = 'pos_team2'
const CUSTOMER = 'pos_customer'
const FOREIGN_CUSTOMER = 'pos_customer2'
const SERVICE = 'pos_service'
const FOREIGN_SERVICE = 'pos_service2'

let n = 0
const newId = () => `pos_txn_${n++}`

const openSale = async (
  { org = ORG, team = TEAM, customer = CUSTOMER, bookingId = null as string | null } = {},
) => {
  const id = newId()
  await pool.query(
    `insert into transactions (id, organization_id, team_id, customer_id, booking_id,
                               status, subtotal, discount, total, currency)
     values ($1, $2, $3, $4, $5, 'open', 150000, 0, 150000, 'IDR')`,
    [id, org, team, customer, bookingId])
  return id
}

const addLine = (txn: string, { org = ORG, service = SERVICE, price = 150000, qty = 1 } = {}) =>
  pool.query(
    `insert into transaction_lines (id, transaction_id, organization_id, service_id,
                                    name, unit_price, quantity, discount)
     values ($1, $2, $3, $4, 'Potong', $5, $6, 0)`,
    [crypto.randomUUID(), txn, org, service, price, qty])

const pay = (txn: string, amount = 150000, method = 'cash') =>
  pool.query(
    `insert into transaction_payments (id, transaction_id, organization_id, method, amount)
     values ($1, $2, $3, $4, $5)`,
    [crypto.randomUUID(), txn, ORG, method, amount])

const complete = (txn: string) => pool.query(
  `update transactions set status = 'completed', completed_at = now() where id = $1`, [txn])

beforeAll(async () => {
  await pool.query(`delete from organizations where id = any($1)`, [[ORG, ORG2]])
  await pool.query(`
    insert into organizations (id, name, slug, created_at)
    values ($1, 'Pos', 'pos-one', now()), ($2, 'Pos Two', 'pos-two', now())`, [ORG, ORG2])
  await pool.query(`
    insert into teams (id, name, organization_id, created_at)
    values ($1, 'Cabang Pos', $2, now()), ($3, 'Cabang Pos2', $4, now())`,
    [TEAM, ORG, TEAM2, ORG2])
  for (const [id, org] of [[CUSTOMER, ORG], [FOREIGN_CUSTOMER, ORG2]] as const) {
    await pool.query(
      `insert into customers (id, organization_id, name) values ($1, $2, 'Pelanggan')`, [id, org])
  }
  for (const [id, org] of [[SERVICE, ORG], [FOREIGN_SERVICE, ORG2]] as const) {
    await pool.query(
      `insert into services (id, organization_id, name, duration_minutes, price)
       values ($1, $2, 'Potong', 60, 150000)`, [id, org])
  }
})

afterAll(async () => {
  await pool.query(`delete from organizations where id = any($1)`, [[ORG, ORG2]])
  await pool.end()
})

beforeEach(async () => {
  // TRUNCATE, not DELETE, and not "reopen then delete": the trigger under test
  // refuses both of those, which is exactly the point of it. TRUNCATE fires
  // statement-level triggers only, never the row-level one -- so teardown gets
  // its own door and the guarantee stays absolute for every ordinary write.
  //
  // Safe to hit the whole table: Vitest runs files sequentially against a
  // freshly built schema, so nothing else has rows here.
  await pool.query(
    `truncate transaction_payments, transaction_lines, transactions cascade`)
})

describe('immutability after completion', () => {
  it('refuses to update a completed transaction', async () => {
    const id = await openSale()
    await complete(id)
    await expect(pool.query(`update transactions set total = 1 where id = $1`, [id]))
      .rejects.toThrow(/settled and cannot be changed/)
  })

  it('refuses to delete a completed transaction', async () => {
    const id = await openSale()
    await complete(id)
    await expect(pool.query(`delete from transactions where id = $1`, [id]))
      .rejects.toThrow(/settled and cannot be deleted/)
  })

  it('still allows editing an OPEN transaction -- the trigger is not refusing everything', async () => {
    const id = await openSale()
    await expect(pool.query(`update transactions set discount = 5000 where id = $1`, [id]))
      .resolves.toBeTruthy()
    await addLine(id)
    await expect(pool.query(`delete from transaction_lines where transaction_id = $1`, [id]))
      .resolves.toBeTruthy()
  })

  it('refuses to change a completed sale\'s LINES -- the receipt cannot be rewritten', async () => {
    const id = await openSale()
    await addLine(id)
    await complete(id)
    await expect(pool.query(
      `update transaction_lines set unit_price = 1 where transaction_id = $1`, [id]))
      .rejects.toThrow(/settled; its lines cannot change/)
    await expect(pool.query(
      `delete from transaction_lines where transaction_id = $1`, [id]))
      .rejects.toThrow(/settled; its lines cannot change/)
    await expect(addLine(id)).rejects.toThrow(/settled; its lines cannot change/)
  })

  it('refuses to add or change a completed sale\'s PAYMENTS', async () => {
    const id = await openSale()
    await pay(id)
    await complete(id)
    await expect(pay(id, 1)).rejects.toThrow(/settled; its lines cannot change/)
    await expect(pool.query(
      `update transaction_payments set amount = 1 where transaction_id = $1`, [id]))
      .rejects.toThrow(/settled; its lines cannot change/)
  })
})

describe('voiding is a reversal, not a delete', () => {
  const reverse = async (original: string) => {
    const id = newId()
    await pool.query(
      `insert into transactions (id, organization_id, team_id, customer_id, status,
                                 reverses_id, subtotal, discount, total, currency,
                                 completed_at)
       select $1, t.organization_id, t.team_id, t.customer_id, 'reversal', t.id,
              -t.subtotal, -t.discount, -t.total, t.currency, now()
         from transactions t where t.id = $2`, [id, original])
    return id
  }

  it('nets to zero across the ledger, with no report having to subtract anything', async () => {
    const id = await openSale()
    await complete(id)
    await reverse(id)
    const { rows } = await pool.query(
      `select coalesce(sum(total), 0)::bigint as revenue from transactions
        where organization_id = $1 and status <> 'open'`, [ORG])
    expect(Number(rows[0].revenue)).toBe(0)
  })

  it('leaves the original readable and untouched', async () => {
    const id = await openSale()
    await complete(id)
    await reverse(id)
    const { rows } = await pool.query(
      `select status, total from transactions where id = $1`, [id])
    expect(rows[0]).toMatchObject({ status: 'completed', total: '150000' })
  })

  it('refuses a second reversal of the same sale', async () => {
    const id = await openSale()
    await complete(id)
    await reverse(id)
    await expect(reverse(id)).rejects.toThrow(/transactions_reverses/)
  })
})

describe('what the database refuses outright', () => {
  it('refuses a negative total unless the row is a reversal', async () => {
    await expect(pool.query(
      `insert into transactions (id, organization_id, team_id, status, subtotal,
                                 discount, total, currency)
       values ($1, $2, $3, 'open', 100000, 200000, -100000, 'IDR')`,
      [newId(), ORG, TEAM])).rejects.toThrow(/transactions_total_sign/)
  })

  it('refuses a status outside the three', async () => {
    await expect(pool.query(
      `insert into transactions (id, organization_id, team_id, status, currency)
       values ($1, $2, $3, 'refunded', 'IDR')`,
      [newId(), ORG, TEAM])).rejects.toThrow(/transactions_status/)
  })

  it('refuses a payment method it does not know', async () => {
    const id = await openSale()
    await expect(pool.query(
      `insert into transaction_payments (id, transaction_id, organization_id, method, amount)
       values ($1, $2, $3, 'crypto', 1)`, [crypto.randomUUID(), id, ORG]))
      .rejects.toThrow(/transaction_payments_method/)
  })

  it('refuses a zero or negative quantity', async () => {
    const id = await openSale()
    await expect(addLine(id, { qty: 0 })).rejects.toThrow(/transaction_lines_quantity/)
  })

  it('refuses another salon\'s customer, service, branch or transaction', async () => {
    await expect(openSale({ customer: FOREIGN_CUSTOMER }))
      .rejects.toThrow(/transactions_customer_fk/)
    await expect(openSale({ team: TEAM2 })).rejects.toThrow(/transactions_team_fk/)
    const id = await openSale()
    await expect(addLine(id, { service: FOREIGN_SERVICE }))
      .rejects.toThrow(/transaction_lines_service_fk/)
    await expect(addLine(id, { org: ORG2 })).rejects.toThrow(/transaction_lines_txn_fk/)
  })

  it('refuses a brand colour that is not #rrggbb', async () => {
    for (const bad of ['red', '#fff', '#12345g', 'javascript:alert(1)', '#123456;x']) {
      await expect(pool.query(
        `update salon_profiles set brand_color = $2 where organization_id = $1`, [ORG, bad]),
      bad).rejects.toThrow(/salon_profiles_brand_color/)
    }
    await expect(pool.query(
      `update salon_profiles set brand_color = '#1a2b3c' where organization_id = $1`, [ORG]))
      .resolves.toBeTruthy()
  })
})

describe('one booking, one sale', () => {
  let bookingId: string

  beforeEach(async () => {
    await pool.query(
      `truncate transaction_payments, transaction_lines, transactions cascade`)
    await pool.query(`delete from bookings where organization_id = $1`, [ORG])
    await pool.query(`
      insert into users (id, name, email, email_verified, created_at, updated_at)
      values ('pos_stylist', 'Pos Stylist', 'pos@pos.local', true, now(), now())
      on conflict (id) do nothing`)
    await pool.query(`
      insert into members (id, user_id, organization_id, role, created_at)
      values ('pos_m', 'pos_stylist', $1, 'stylist', now())
      on conflict (id) do nothing`, [ORG])
    await pool.query(`update staff_profiles set team_id = $1
                       where user_id = 'pos_stylist' and organization_id = $2`, [TEAM, ORG])
    bookingId = crypto.randomUUID()
    await pool.query(
      `insert into bookings (id, organization_id, team_id, staff_user_id, customer_id,
                             service_id, starts_at, ends_at, status,
                             duration_minutes, price, currency)
       values ($1, $2, $3, 'pos_stylist', $4, $5, '2027-06-09 10:00', '2027-06-09 11:00',
               'confirmed', 60, 150000, 'IDR')`,
      [bookingId, ORG, TEAM, CUSTOMER, SERVICE])
  })

  it('refuses to charge the same booking twice', async () => {
    await openSale({ bookingId })
    await expect(openSale({ bookingId })).rejects.toThrow(/transactions_one_per_booking/)
  })

  it('still allows the REVERSAL of that sale to name the same booking', async () => {
    // The index is partial for this reason: a void must be able to point at
    // the booking it reverses without reading as a second charge.
    const id = await openSale({ bookingId })
    await complete(id)
    const reversal = newId()
    await expect(pool.query(
      `insert into transactions (id, organization_id, team_id, customer_id, booking_id,
                                 status, reverses_id, subtotal, discount, total, currency)
       values ($1, $2, $3, $4, $5, 'reversal', $6, -150000, 0, -150000, 'IDR')`,
      [reversal, ORG, TEAM, CUSTOMER, bookingId, id])).resolves.toBeTruthy()
  })

  it('refuses another salon\'s booking', async () => {
    await expect(openSale({ bookingId: crypto.randomUUID() }))
      .rejects.toThrow(/transactions_booking_fk/)
  })
})
