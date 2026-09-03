import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from './db'
import { checkout, closeShift, currentShift, voidSale } from '../lib/pos'

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
  // TRUNCATE first: deleting the organization cascades into settled
  // transactions, which the immutability trigger refuses -- correctly.
  await pool.query(`truncate transaction_payments, transaction_lines, transactions cascade`)
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

describe('checkout', () => {
  const STAFF = 'pos_stylist'

  beforeEach(async () => {
    await pool.query(`truncate transaction_payments, transaction_lines, transactions cascade`)
    await pool.query(`delete from shifts where organization_id = $1`, [ORG])
    await pool.query(`update salon_profiles set next_invoice_no = 1 where organization_id = $1`, [ORG])
    await pool.query(`delete from service_branch_overrides where service_id = $1`, [SERVICE])
    await pool.query(`update services set price = 150000 where id = $1`, [SERVICE])
  })

  const sale = (over: Partial<Parameters<typeof checkout>[0]> = {}) => checkout({
    organizationId: ORG, teamId: TEAM, userId: STAFF, method: 'cash',
    items: [{ serviceId: SERVICE, quantity: 1, discount: 0 }], ...over,
  })

  const readSale = async (id: string) => (await pool.query(
    `select status, subtotal, discount, total, invoice_no, shift_id, currency
       from transactions where id = $1`, [id])).rows[0]

  it('writes a completed sale, its line and its payment, and numbers it', async () => {
    const { id, invoiceNo } = await sale()
    expect(invoiceNo).toBe(1)
    expect(await readSale(id)).toMatchObject({
      status: 'completed', subtotal: '150000', discount: '0', total: '150000',
      invoice_no: 1, currency: 'IDR',
    })
    const lines = await pool.query(
      `select name, unit_price, quantity from transaction_lines where transaction_id = $1`, [id])
    expect(lines.rows[0]).toMatchObject({ name: 'Potong', unit_price: '150000', quantity: 1 })
    const paid = await pool.query(
      `select method, amount, provider, status from transaction_payments
        where transaction_id = $1`, [id])
    expect(paid.rows[0]).toMatchObject({
      method: 'cash', amount: '150000', provider: 'manual', status: 'settled',
    })
  })

  it('never leaves an OPEN row behind -- the cart is not a row', async () => {
    await sale()
    const { rows } = await pool.query(
      `select count(*)::int n from transactions where status = 'open'`)
    expect(rows[0].n, 'an abandoned open cart would block its booking forever').toBe(0)
  })

  it('numbers sales consecutively, per salon', async () => {
    expect((await sale()).invoiceNo).toBe(1)
    expect((await sale()).invoiceNo).toBe(2)
    expect((await sale()).invoiceNo).toBe(3)
  })

  it('hands two concurrent sales different numbers', async () => {
    // One `update ... returning` per allocation, so this serialises per salon
    // without an explicit lock. A read-then-write would hand out duplicates.
    const results = await Promise.all([sale(), sale(), sale()])
    const numbers = results.map((r) => r.invoiceNo).sort()
    expect(new Set(numbers).size).toBe(3)
  })

  it('prices from the branch, ignoring anything a caller might post', async () => {
    await pool.query(`
      insert into service_branch_overrides (service_id, team_id, organization_id, price, offered)
      values ($1, $2, $3, 99000, true)`, [SERVICE, TEAM, ORG])
    const { id } = await sale()
    expect(await readSale(id)).toMatchObject({ subtotal: '99000', total: '99000' })
  })

  it('applies line and order discounts as amounts', async () => {
    const { id } = await sale({
      items: [{ serviceId: SERVICE, quantity: 2, discount: 10000 }],
      discount: 5000,
    })
    expect(await readSale(id)).toMatchObject({
      subtotal: '300000', discount: '15000', total: '285000',
    })
  })

  it('refuses a discount larger than the sale', async () => {
    await expect(sale({ discount: 200000 })).rejects.toThrow('BAD_DISCOUNT')
    await expect(sale({ items: [{ serviceId: SERVICE, quantity: 1, discount: 200000 }] }))
      .rejects.toThrow('BAD_DISCOUNT')
    const { rows } = await pool.query(`select count(*)::int n from transactions`)
    expect(rows[0].n, 'and writes nothing').toBe(0)
  })

  it('refuses a service the branch does not offer, whole', async () => {
    await pool.query(`
      insert into service_branch_overrides (service_id, team_id, organization_id, offered)
      values ($1, $2, $3, false)`, [SERVICE, TEAM, ORG])
    await expect(sale()).rejects.toThrow('NOT_OFFERED')
  })

  it('refuses an empty cart', async () => {
    await expect(sale({ items: [] })).rejects.toThrow('EMPTY_CART')
  })

  it('opens a shift on the first sale and reuses it after', async () => {
    const a = await sale()
    const b = await sale()
    const { rows } = await pool.query(
      `select count(*)::int n from shifts where team_id = $1 and closed_at is null`, [TEAM])
    expect(rows[0].n, 'one open shift, not one per sale').toBe(1)
    const shifts = await pool.query(
      `select distinct shift_id from transactions where id = any($1)`, [[a.id, b.id]])
    expect(shifts.rows).toHaveLength(1)
  })

  it('allows only one open shift per branch, even concurrently', async () => {
    await Promise.all([
      currentShift(ORG, TEAM, STAFF), currentShift(ORG, TEAM, STAFF),
      currentShift(ORG, TEAM, STAFF),
    ])
    const { rows } = await pool.query(
      `select count(*)::int n from shifts where team_id = $1 and closed_at is null`, [TEAM])
    expect(rows[0].n).toBe(1)
  })
})

describe('voiding within the shift window', () => {
  const STAFF = 'pos_stylist'

  beforeEach(async () => {
    await pool.query(`truncate transaction_payments, transaction_lines, transactions cascade`)
    await pool.query(`delete from shifts where organization_id = $1`, [ORG])
    await pool.query(`update salon_profiles set next_invoice_no = 1 where organization_id = $1`, [ORG])
    await pool.query(`delete from service_branch_overrides where service_id = $1`, [SERVICE])
  })

  const sale = () => checkout({
    organizationId: ORG, teamId: TEAM, userId: STAFF, method: 'cash',
    items: [{ serviceId: SERVICE, quantity: 1, discount: 0 }],
  })

  it('mirrors the sale, and the ledger nets to zero', async () => {
    const { id } = await sale()
    const { invoiceNo } = await voidSale(id, ORG)
    expect(invoiceNo, 'a void is a document too').toBe(2)
    const { rows } = await pool.query(
      `select coalesce(sum(total), 0)::bigint revenue from transactions
        where organization_id = $1 and status <> 'open'`, [ORG])
    expect(Number(rows[0].revenue)).toBe(0)
    const lines = await pool.query(
      `select sum(unit_price * quantity)::bigint gross from transaction_lines l
         join transactions t on t.id = l.transaction_id
        where t.organization_id = $1`, [ORG])
    expect(Number(lines.rows[0].gross), 'the lines mirror too').toBe(0)
  })

  it('is REFUSED once the shift has closed', async () => {
    const { id } = await sale()
    const { rows } = await pool.query(
      `select id from shifts where team_id = $1 and closed_at is null`, [TEAM])
    await closeShift(rows[0].id, ORG, STAFF)
    await expect(voidSale(id, ORG)).rejects.toThrow('SHIFT_CLOSED')
  })

  it('refuses a second close of the same shift', async () => {
    await sale()
    const { rows } = await pool.query(
      `select id from shifts where team_id = $1 and closed_at is null`, [TEAM])
    await closeShift(rows[0].id, ORG, STAFF)
    await expect(closeShift(rows[0].id, ORG, STAFF)).rejects.toThrow('SHIFT_NOT_OPEN')
  })

  it('opens a fresh shift after one closes, and sales there are voidable again', async () => {
    const first = await sale()
    const { rows } = await pool.query(
      `select id from shifts where team_id = $1 and closed_at is null`, [TEAM])
    await closeShift(rows[0].id, ORG, STAFF)
    const second = await sale()
    await expect(voidSale(first.id, ORG)).rejects.toThrow('SHIFT_CLOSED')
    await expect(voidSale(second.id, ORG)).resolves.toBeTruthy()
  })

  it('cannot reach another salon\'s sale', async () => {
    const { id } = await sale()
    await expect(voidSale(id, ORG2)).rejects.toThrow('NOT_FOUND')
  })
})

describe('checkout completes the booking behind it', () => {
  const STAFF = 'pos_stylist'
  let bookingId: string

  beforeEach(async () => {
    await pool.query(`truncate transaction_payments, transaction_lines, transactions cascade`)
    await pool.query(`delete from shifts where organization_id = $1`, [ORG])
    await pool.query(`delete from bookings where organization_id = $1`, [ORG])
    bookingId = crypto.randomUUID()
    await pool.query(
      `insert into bookings (id, organization_id, team_id, staff_user_id, customer_id,
                             service_id, starts_at, ends_at, status,
                             duration_minutes, price, currency)
       values ($1, $2, $3, 'pos_stylist', $4, $5, '2027-07-14 10:00', '2027-07-14 11:00',
               'pending', 60, 150000, 'IDR')`,
      [bookingId, ORG, TEAM, CUSTOMER, SERVICE])
  })

  it('completes a PENDING booking -- money beats a front-desk click', async () => {
    // setBookingStatus refuses pending -> completed on purpose. Checkout
    // widens it deliberately (spec 2.5): someone who paid showed up.
    await checkout({
      organizationId: ORG, teamId: TEAM, userId: STAFF, method: 'qris',
      items: [{ serviceId: SERVICE, quantity: 1, discount: 0 }],
      bookingId, customerId: CUSTOMER,
    })
    const { rows } = await pool.query(`select status from bookings where id = $1`, [bookingId])
    expect(rows[0].status).toBe('completed')
  })

  it('refuses to charge the same booking twice', async () => {
    const args = {
      organizationId: ORG, teamId: TEAM, userId: STAFF, method: 'cash' as const,
      items: [{ serviceId: SERVICE, quantity: 1, discount: 0 }],
      bookingId, customerId: CUSTOMER,
    }
    await checkout(args)
    await expect(checkout(args)).rejects.toThrow('ALREADY_CHARGED')
  })

  it('a sale with no booking and no customer is fine', async () => {
    const { id } = await checkout({
      organizationId: ORG, teamId: TEAM, userId: STAFF, method: 'cash',
      items: [{ serviceId: SERVICE, quantity: 1, discount: 0 }],
    })
    const { rows } = await pool.query(
      `select customer_id, booking_id from transactions where id = $1`, [id])
    expect(rows[0]).toEqual({ customer_id: null, booking_id: null })
  })
})
