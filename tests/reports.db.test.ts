import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from './db'
import {
  bookingFunnel, revenueByDay, revenueRange, staffPerformance, topServices,
} from '../lib/reports'
import { commissionRecap } from '../lib/commission'
import { checkout, voidSale } from '../lib/pos'

/**
 * PRD §5.6's figures, against real Postgres.
 *
 * TWO stylists with sales, deliberately. With one, "scoped to this stylist" and
 * "the whole branch" are the same number and every scoping assertion passes
 * for free -- which is how two earlier assertions in this project proved
 * nothing.
 */
const pool = new Pool({ connectionString: TEST_DATABASE_URL })

const ORG = 'rep_org'
const ORG2 = 'rep_org2'
const TEAM = 'rep_team'
const TEAM_B = 'rep_team_b'
const TEAM_OTHER = 'rep_other_team'
const SINTA = 'rep_sinta'
const RINA = 'rep_rina'
const OWNER = 'rep_owner'
const CUSTOMER = 'rep_customer'
const CUT = 'rep_cut'
const SPA = 'rep_spa'
const SHAMPOO = 'rep_shampoo'

const FROM = '2027-11-01'
const TO = '2027-11-30'

/**
 * Today, and a range around it.
 *
 * A void stamps `completed_at = now()`, so a reversal ALWAYS lands in the
 * period the void happened in -- never in the backdated period of the sale it
 * reverses. That is the same behaviour payroll has, and it is correct
 * accounting: a past period that has been reported does not silently change.
 *
 * So any assertion about a void reducing a figure has to put both the sale and
 * the void inside the range, which means dating the sale TODAY.
 */
const iso = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const TODAY = iso(new Date())
const todayScope = (staffUserId: string | null = null) => ({
  organizationId: ORG, teamId: TEAM, from: TODAY, to: TODAY, staffUserId,
})
const now = (hour: string) => `${TODAY} ${hour}`
const scope = (staffUserId: string | null = null) => ({
  organizationId: ORG, teamId: TEAM, from: FROM, to: TO, staffUserId,
})

/** One sale. `at` is a timestamp inside November unless stated. */
const sell = (
  items: Parameters<typeof checkout>[0]['items'], at: string, teamId = TEAM,
) => checkout({
  organizationId: ORG, teamId, userId: OWNER, method: 'cash',
  items, customerId: CUSTOMER, completedAt: at,
})

const svc = (serviceId: string, staffUserId: string, quantity = 1, discount = 0) =>
  ({ serviceId, quantity, discount, staffUserId })

beforeAll(async () => {
  await pool.query(`delete from organizations where id = any($1)`, [[ORG, ORG2]])
  await pool.query(`
    insert into organizations (id, name, slug, created_at)
    values ($1, 'Rep', 'rep-one', now()), ($2, 'Rep Two', 'rep-two', now())`, [ORG, ORG2])
  await pool.query(`
    insert into teams (id, name, organization_id, created_at)
    values ($1, 'Cabang A', $2, now()), ($3, 'Cabang B', $2, now()),
           ($4, 'Cabang Lain', $5, now())`,
    [TEAM, ORG, TEAM_B, TEAM_OTHER, ORG2])
  await pool.query(`
    update subscriptions set plan_id = (select id from plans where key = 'business')
     where organization_id = any($1)`, [[ORG, ORG2]])

  for (const [id, org, role, team] of [
    [OWNER, ORG, 'owner', TEAM], [SINTA, ORG, 'stylist', TEAM],
    [RINA, ORG, 'stylist', TEAM], ['rep_outsider', ORG2, 'owner', TEAM_OTHER],
  ] as const) {
    await pool.query(`
      insert into users (id, name, email, email_verified, created_at, updated_at)
      values ($1, $1, $1 || '@rep.local', true, now(), now())`, [id])
    await pool.query(`
      insert into members (id, user_id, organization_id, role, created_at)
      values ($1 || '_m', $1, $2, $3, now())`, [id, org, role])
    await pool.query(`update staff_profiles set team_id = $1
                       where user_id = $2 and organization_id = $3`, [team, id, org])
  }

  await pool.query(
    `insert into customers (id, organization_id, name) values ($1, $2, 'Pelanggan')`,
    [CUSTOMER, ORG])
  await pool.query(`
    insert into services (id, organization_id, name, duration_minutes, price)
    values ($1, $2, 'Potong', 60, 100000), ($3, $2, 'Hair Spa', 60, 300000)`,
    [CUT, ORG, SPA])
  for (const service of [CUT, SPA]) {
    for (const staff of [SINTA, RINA, OWNER]) {
      await pool.query(
        `insert into service_staff (service_id, user_id, organization_id)
         values ($1, $2, $3)`, [service, staff, ORG])
    }
  }
  await pool.query(
    `insert into products (id, organization_id, name, kind, price)
     values ($1, $2, 'Sampo', 'retail', 50000)`, [SHAMPOO, ORG])
  await pool.query(
    `insert into stock_movements (id, organization_id, team_id, product_id, quantity, reason)
     values ($1, $2, $3, $4, 100, 'purchase')`,
    [crypto.randomUUID(), ORG, TEAM, SHAMPOO])
  await pool.query(
    `update salon_profiles set commission_kind = 'percent', commission_value = 1000
      where organization_id = $1`, [ORG])
})

afterAll(async () => {
  await pool.query(`truncate transaction_payments, transaction_lines, transactions cascade`)
  await pool.query(`delete from organizations where id = any($1)`, [[ORG, ORG2]])
  await pool.query(`delete from users where id like 'rep_%'`)
  await pool.end()
})

beforeEach(async () => {
  await pool.query(`truncate transaction_payments, transaction_lines, transactions cascade`)
  await pool.query(`delete from shifts where organization_id = $1`, [ORG])
  await pool.query(`delete from bookings where organization_id = $1`, [ORG])
})

describe('revenue', () => {
  it('sums the range and excludes what falls outside it', async () => {
    await sell([svc(CUT, SINTA)], '2027-11-10 10:00')
    await sell([svc(CUT, SINTA)], '2027-10-31 23:00')   // the day before
    await sell([svc(CUT, SINTA)], '2027-12-01 00:30')   // the day after
    expect(await revenueRange(scope())).toBe(100000)
  })

  it('includes the LAST day of the range -- `to` is inclusive', async () => {
    await sell([svc(CUT, SINTA)], '2027-11-30 21:00')
    expect(await revenueRange(scope()),
      'a report a day short of its own end date is worse than useless').toBe(100000)
  })

  it('drops when a sale is voided, with no reversal clause in the query', async () => {
    const { id } = await sell([svc(CUT, SINTA)], now('10:00'))
    await sell([svc(SPA, RINA)], now('11:00'))
    await voidSale(id, ORG, OWNER)
    expect(await revenueRange(todayScope())).toBe(300000)
  })

  it('leaves a PAST period untouched when a sale in it is voided', async () => {
    // A void is an event now: it books into the period it happened in, never
    // into the backdated period of the sale it reverses. Same behaviour
    // payroll has, and it is why a closed month cannot be rewritten by a void.
    const { id } = await sell([svc(CUT, SINTA)], '2027-11-10 10:00')
    await voidSale(id, ORG, OWNER)
    expect(await revenueRange(scope()), 'November still shows the sale').toBe(100000)
    expect(await revenueRange(todayScope()), 'and today carries the reversal')
      .toBe(-100000)
  })

  it('counts another branch and another salon as neither', async () => {
    await sell([svc(CUT, SINTA)], '2027-11-10 10:00', TEAM_B)
    expect(await revenueRange(scope())).toBe(0)
    expect(await revenueRange({ ...scope(), teamId: TEAM_B })).toBe(100000)
  })

  it('scoped to a stylist counts THEIR lines, not the branch', async () => {
    await sell([svc(CUT, SINTA)], '2027-11-10 10:00')
    await sell([svc(SPA, RINA)], '2027-11-11 10:00')
    expect(await revenueRange(scope()), 'the branch').toBe(400000)
    expect(await revenueRange(scope(SINTA)), 'hers alone').toBe(100000)
    expect(await revenueRange(scope(RINA)), 'and his').toBe(300000)
  })

  it('scoped revenue EXCLUDES retail, which branch revenue includes', async () => {
    // The two figures deliberately disagree: a transaction's total carries
    // retail and any order-level discount, and neither is one stylist's.
    await sell([svc(CUT, SINTA), { productId: SHAMPOO, quantity: 1, discount: 0 }],
      '2027-11-10 10:00')
    expect(await revenueRange(scope()), 'service plus shampoo').toBe(150000)
    expect(await revenueRange(scope(SINTA)), 'her service only').toBe(100000)
  })

  it('gives every day in the range, including the empty ones', async () => {
    await sell([svc(CUT, SINTA)], '2027-11-10 10:00')
    const days = await revenueByDay({ ...scope(), from: '2027-11-09', to: '2027-11-11' })
    // A trend that skips empty days draws a straight run where the salon was
    // shut, which is a lie about its own shape.
    expect(days.map((d) => d.day)).toEqual(['2027-11-09', '2027-11-10', '2027-11-11'])
    expect(days.map((d) => d.revenue)).toEqual([0, 100000, 0])
  })
})

describe('top services', () => {
  it('ranks by money and by NET count, which a void changes', async () => {
    // Potong: three sold, one voided -> 2 net, 200.000.
    // Hair Spa: one sold -> 1 net, 300.000.
    // So Hair Spa leads by revenue and Potong leads by volume, and a query
    // that summed raw quantity would give Potong 4.
    const { id } = await sell([svc(CUT, SINTA)], now('09:00'))
    await sell([svc(CUT, SINTA)], now('10:00'))
    await sell([svc(CUT, RINA)], now('11:00'))
    await sell([svc(SPA, RINA)], now('12:00'))
    await voidSale(id, ORG, OWNER)

    const { byRevenue, byCount } = await topServices(todayScope())
    expect(byRevenue.map((s) => s.name)).toEqual(['Hair Spa', 'Potong'])
    expect(byCount.map((s) => [s.name, s.count])).toEqual([
      ['Potong', 2], ['Hair Spa', 1],
    ])
  })

  it('leaves retail out -- a product is not a service', async () => {
    await sell([{ productId: SHAMPOO, quantity: 2, discount: 0 }], '2027-11-10 10:00')
    expect(await topServices(scope())).toMatchObject({ byRevenue: [], byCount: [] })
  })

  it('scoped to a stylist shows only what they performed', async () => {
    await sell([svc(CUT, SINTA)], '2027-11-05 10:00')
    await sell([svc(SPA, RINA)], '2027-11-06 10:00')
    expect((await topServices(scope(SINTA))).byRevenue.map((s) => s.name))
      .toEqual(['Potong'])
    expect((await topServices(scope(RINA))).byRevenue.map((s) => s.name))
      .toEqual(['Hair Spa'])
  })

  it('takes the top N, ordered', async () => {
    await sell([svc(CUT, SINTA), svc(SPA, RINA)], '2027-11-05 10:00')
    expect((await topServices(scope(), 1)).byRevenue.map((s) => s.name))
      .toEqual(['Hair Spa'])
  })
})

describe('staff performance', () => {
  it('attributes revenue, services and commission per stylist', async () => {
    await sell([svc(CUT, SINTA), svc(SPA, RINA)], '2027-11-10 10:00')
    const rows = Object.fromEntries(
      (await staffPerformance(scope())).map((r) => [r.staffUserId, r]))
    expect(rows[SINTA]).toMatchObject({ revenue: 100000, services: 1, commission: 10000 })
    expect(rows[RINA]).toMatchObject({ revenue: 300000, services: 1, commission: 30000 })
  })

  it('never lists a product line -- it has no stylist to attribute to', async () => {
    await sell([{ productId: SHAMPOO, quantity: 1, discount: 0 }], '2027-11-10 10:00')
    expect(await staffPerformance(scope())).toEqual([])
  })

  it('agrees with commissionRecap over the same window', async () => {
    // Two queries over the same rows disagreeing is the failure this slice
    // could most easily hide -- payroll pays on one of them.
    await sell([svc(CUT, SINTA)], '2027-11-10 10:00')
    await sell([svc(SPA, SINTA)], '2027-11-20 10:00')
    const mine = (await staffPerformance(scope())).find((r) => r.staffUserId === SINTA)!
    const recap = (await commissionRecap(ORG, '2027-11-01'))
      .find((r) => r.staffUserId === SINTA)!
    expect(mine.commission).toBe(recap.commission)
  })

  it('subtracts a voided sale from all three columns', async () => {
    const { id } = await sell([svc(SPA, SINTA)], now('10:00'))
    await sell([svc(CUT, SINTA)], now('11:00'))
    await voidSale(id, ORG, OWNER)
    const [row] = await staffPerformance(todayScope())
    expect(row).toMatchObject({ revenue: 100000, services: 1, commission: 10000 })
  })
})

describe('the booking funnel', () => {
  const book = (status: string, at: string, staffUserId = SINTA) => pool.query(
    `insert into bookings (id, organization_id, team_id, staff_user_id, customer_id,
                           service_id, starts_at, ends_at, status,
                           duration_minutes, price, currency)
     values ($1, $2, $3, $4, $5, $6, $7::timestamp, $7::timestamp + interval '1 hour',
             $8, 60, 100000, 'IDR')`,
    [crypto.randomUUID(), ORG, TEAM, staffUserId, CUSTOMER, CUT, at, status])

  it('counts by STARTS_AT, not by when the booking was made', async () => {
    // Created now, for a slot inside the range: it belongs to the range.
    await book('completed', '2027-11-10 10:00')
    await book('completed', '2027-12-10 10:00')
    expect((await bookingFunnel(scope())).total).toBe(1)
  })

  it('keeps cancellations in the denominator', async () => {
    await book('completed', '2027-11-10 10:00')
    await book('completed', '2027-11-11 10:00')
    await book('cancelled', '2027-11-12 10:00')
    await book('no_show', '2027-11-13 10:00')
    const f = await bookingFunnel(scope())
    // Hiding cancellations would report 67% completion instead of 50%.
    expect(f).toMatchObject({
      total: 4, completed: 2, cancelled: 1, noShow: 1,
      completionRate: 50, noShowRate: 25,
    })
  })

  it('reports zero on an empty range rather than NaN', async () => {
    const f = await bookingFunnel(scope())
    expect(f).toMatchObject({ total: 0, completionRate: 0, noShowRate: 0 })
    expect(Number.isNaN(f.completionRate)).toBe(false)
  })

  it('scoped to a stylist counts only their bookings', async () => {
    await book('completed', '2027-11-10 10:00', SINTA)
    await book('no_show', '2027-11-11 10:00', RINA)
    expect((await bookingFunnel(scope())).total).toBe(2)
    expect(await bookingFunnel(scope(SINTA))).toMatchObject({ total: 1, noShowRate: 0 })
    expect(await bookingFunnel(scope(RINA))).toMatchObject({ total: 1, noShowRate: 100 })
  })
})
