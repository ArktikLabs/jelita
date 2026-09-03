/**
 * Demo data (PRD §8): "realistic Indonesian salon data: 6 staff, 15 services,
 * 40 customers, 3 weeks of transaction history — so charts and reports look
 * alive, not empty."
 *
 * EVERY sale and booking goes through the real write paths -- `checkout` and
 * `createBooking` -- rather than being inserted directly. A seed that writes
 * its own rows produces data the application could never produce, and every
 * report built on it looks right while being wrong. The cost is that this is
 * slower than a few INSERTs; the benefit is that commissions, stock movements,
 * invoice numbers and the double-booking constraint all apply to it.
 *
 *   pnpm seed:demo            # against DATABASE_URL
 *
 * Destructive for its own salon only: it drops the organization by slug and
 * rebuilds it, so re-running gives the same shape rather than doubling it.
 */
import { Pool } from 'pg'
import { createLocalAccountIssuer } from 'better-auth'
import { auth } from '../lib/auth'
import { createBooking } from '../lib/booking'
import { checkout } from '../lib/pos'
import { recordMovement } from '../lib/inventory'

const SLUG = 'ovarya'
const DOMAIN = 'ovarya.demo'
const PW = 'demo12345'
const DAYS = 21

/** Deterministic, so two runs produce the same demo and a screenshot taken
 *  yesterday still matches what the reports say today. */
let seed = 20260903
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]
const between = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1))

const SERVICES: [string, number, number, string][] = [
  ['Creambath', 60, 85000, 'Perawatan Rambut'],
  ['Hair Spa', 75, 120000, 'Perawatan Rambut'],
  ['Smoothing', 180, 450000, 'Perawatan Rambut'],
  ['Keratin Treatment', 150, 550000, 'Perawatan Rambut'],
  ['Hair Mask', 45, 95000, 'Perawatan Rambut'],
  ['Potong Rambut Wanita', 45, 75000, 'Potong & Tata'],
  ['Potong Rambut Pria', 30, 45000, 'Potong & Tata'],
  ['Blow Dry', 30, 55000, 'Potong & Tata'],
  ['Catok / Curly', 45, 65000, 'Potong & Tata'],
  ['Sanggul Pesta', 90, 250000, 'Potong & Tata'],
  ['Pewarnaan Akar', 90, 200000, 'Pewarnaan'],
  ['Highlight', 150, 400000, 'Pewarnaan'],
  ['Gel Nails', 60, 150000, 'Kuku'],
  ['Manicure Pedicure', 75, 130000, 'Kuku'],
  ['Facial Basic', 60, 145000, 'Perawatan Wajah'],
]

const STAFF: [string, string][] = [
  ['Sinta Dewi', 'stylist'],
  ['Rina Marlina', 'stylist'],
  ['Ayu Lestari', 'stylist'],
  ['Bella Kartika', 'stylist'],
  ['Dewi Anggraini', 'frontdesk'],
  ['Putri Handayani', 'admin'],
]

const FIRST = ['Siti', 'Nur', 'Ratna', 'Indah', 'Fitri', 'Maya', 'Lia', 'Wulan',
  'Tari', 'Yuni', 'Ani', 'Rani', 'Mega', 'Dian', 'Eka', 'Vina', 'Gita', 'Hesti',
  'Ika', 'Jeni']
const LAST = ['Rahayu', 'Wijaya', 'Susanti', 'Pratiwi', 'Utami', 'Safitri',
  'Hartono', 'Nugroho', 'Kusuma', 'Maharani']

const PRODUCTS: [string, 'retail' | 'internal', number | null, number][] = [
  ['Sampo Keratin 250ml', 'retail', 145000, 5],
  ['Kondisioner Argan 250ml', 'retail', 135000, 5],
  ['Serum Vitamin Rambut', 'retail', 185000, 3],
  ['Hair Tonic 100ml', 'retail', 95000, 4],
  ['Masker Rambut Profesional', 'internal', null, 10],
  ['Cat Rambut Base', 'internal', null, 8],
]

const iso = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const daysAgo = (n: number) => {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d
}

/**
 * A verified credential login. Verified true because nothing here goes through
 * sendVerificationEmail, and requireEmailVerification would otherwise lock
 * every demo account out of sign-in.
 */
async function createLogin(
  pool: Pool,
  ctx: Awaited<typeof auth.$context>,
  { name, email }: { name: string; email: string },
): Promise<string> {
  const user = await ctx.internalAdapter.createUser(
    { email, name, emailVerified: true }, { method: 'email-password' })
  await ctx.internalAdapter.linkAccount({
    userId: user.id,
    providerId: 'credential',
    issuer: createLocalAccountIssuer('credential'),
    accountId: user.id,
    password: await ctx.password.hash(PW),
  })
  return user.id
}

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required')
  const pool = new Pool({ connectionString: url })

  console.log('clearing any previous demo salon…')
  // TRUNCATE first: deleting the organization cascades into settled
  // transactions, which the immutability trigger refuses -- correctly.
  const { rows: prior } = await pool.query(
    `select id from organizations where slug = $1`, [SLUG])
  if (prior[0]) {
    await pool.query(
      `delete from transaction_payments where organization_id = $1`, [prior[0].id])
    await pool.query(`delete from commissions where organization_id = $1`, [prior[0].id])
    await pool.query(`delete from transaction_lines where organization_id = $1`, [prior[0].id])
    await pool.query(
      `alter table transactions disable trigger transactions_settled_immutable`)
    await pool.query(`delete from transactions where organization_id = $1`, [prior[0].id])
    await pool.query(
      `alter table transactions enable trigger transactions_settled_immutable`)
    await pool.query(`alter table stock_movements disable trigger stock_movements_append_only`)
    await pool.query(`delete from stock_movements where organization_id = $1`, [prior[0].id])
    await pool.query(`alter table stock_movements enable trigger stock_movements_append_only`)
  }
  await pool.query(`delete from organizations where slug = $1`, [SLUG])
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`])

  console.log('owner and salon…')
  const ctx = await auth.$context
  const ownerEmail = `owner@${DOMAIN}`
  const ownerId = await createLogin(pool, ctx, { name: 'Ibu Ovarya', email: ownerEmail })
  const owner = { id: ownerId }

  const orgId = crypto.randomUUID()
  await pool.query(
    `insert into organizations (id, name, slug, created_at) values ($1, $2, $3, now())`,
    [orgId, 'Ovarya Salon & Spa', SLUG])
  await pool.query(
    `insert into members (id, user_id, organization_id, role, created_at)
     values ($1, $2, $3, 'owner', now())`, [crypto.randomUUID(), owner.id, orgId])
  await pool.query(`update subscriptions set plan_id = (select id from plans where key = 'business')
                     where organization_id = $1`, [orgId])
  await pool.query(
    `update salon_profiles set currency = 'IDR', slot_minutes = 30,
       commission_kind = 'percent', commission_value = 1000, brand_color = '#7c3aed'
     where organization_id = $1`, [orgId])

  const teamId = crypto.randomUUID()
  await pool.query(
    `insert into teams (id, name, organization_id, created_at) values ($1, $2, $3, now())`,
    [teamId, 'Ovarya Kemang', orgId])
  await pool.query(
    `update branch_profiles set address = 'Jl. Kemang Raya No. 42, Jakarta Selatan',
       phone = '021-7180042' where team_id = $1`, [teamId])

  console.log('staff…')
  // Logins are created the way tests/e2e/fixtures.ts does, NOT through
  // provisionStaff: that function's guards run through requireUser, which
  // needs a request scope and therefore cannot run in a script.
  //
  // Worth being clear about what is lost. provisionStaff enforces the seat
  // quota and the assignable-role allow-list -- guards, not data shape. The
  // rows written here are the same rows it writes, and everything where shape
  // matters (bookings, sales, commissions, stock) still goes through the real
  // path.
  const staffIds: Record<string, string> = {}
  for (const [name, role] of STAFF) {
    const email = `${name.split(' ')[0].toLowerCase()}@${DOMAIN}`
    staffIds[name] = await createLogin(pool, ctx, { name, email })
    await pool.query(
      `insert into members (id, user_id, organization_id, role, created_at)
       values ($1, $2, $3, $4, now())`,
      [crypto.randomUUID(), staffIds[name], orgId, role])
    if (role !== 'admin') {
      // The members insert seeds staff_profiles (and staff_hours) by trigger;
      // the branch assignment is a separate write.
      await pool.query(`update staff_profiles set team_id = $1
                         where user_id = $2 and organization_id = $3`,
        [teamId, staffIds[name], orgId])
      await pool.query(
        `insert into team_members (id, team_id, user_id, created_at)
         values ($1, $2, $3, now())`, [crypto.randomUUID(), teamId, staffIds[name]])
    }
  }
  const stylists = STAFF.filter(([, r]) => r === 'stylist').map(([n]) => staffIds[n])
  // The owner works the floor -- the common case in a salon this size, and the
  // gap the staff model was changed to allow.
  await pool.query(`update staff_profiles set team_id = $1
                     where user_id = $2 and organization_id = $3`, [teamId, owner.id, orgId])
  stylists.push(owner.id)

  console.log('services…')
  const categories: Record<string, string> = {}
  for (const [, , , cat] of SERVICES) {
    if (categories[cat]) continue
    const id = crypto.randomUUID()
    categories[cat] = id
    await pool.query(
      `insert into service_categories (id, organization_id, name) values ($1, $2, $3)`,
      [id, orgId, cat])
  }
  const serviceIds: string[] = []
  for (const [name, minutes, price, cat] of SERVICES) {
    const id = crypto.randomUUID()
    serviceIds.push(id)
    await pool.query(
      `insert into services (id, organization_id, category_id, name, duration_minutes, price)
       values ($1, $2, $3, $4, $5, $6)`, [id, orgId, categories[cat], name, minutes, price])
    // Every stylist can perform everything, except the two long chemical
    // treatments, which only the two seniors do.
    const eligible = minutes >= 150 ? stylists.slice(0, 2) : stylists
    for (const userId of eligible) {
      await pool.query(
        `insert into service_staff (service_id, user_id, organization_id) values ($1, $2, $3)`,
        [id, userId, orgId])
    }
  }

  console.log('products and opening stock…')
  const productIds: string[] = []
  for (const [name, kind, price, reorder] of PRODUCTS) {
    const id = crypto.randomUUID()
    if (kind === 'retail') productIds.push(id)
    await pool.query(
      `insert into products (id, organization_id, name, kind, price, reorder_level)
       values ($1, $2, $3, $4, $5, $6)`, [id, orgId, name, kind, price, reorder])
    await recordMovement({
      organizationId: orgId, teamId, productId: id,
      quantity: between(12, 30), reason: 'purchase', note: 'Stok awal',
    })
  }

  console.log('customers…')
  const customerIds: string[] = []
  for (let i = 0; i < 40; i++) {
    const id = crypto.randomUUID()
    customerIds.push(id)
    const phone = `0812${String(10000000 + i * 137).slice(0, 8)}`
    await pool.query(
      `insert into customers (id, organization_id, name, phone, phone_key)
       values ($1, $2, $3, $4, $5)`,
      [id, orgId, `${pick(FIRST)} ${pick(LAST)}`, phone, `62${phone.slice(1)}`])
  }

  console.log(`bookings and sales across ${DAYS} days…`)
  let sales = 0
  for (let back = DAYS; back >= 1; back--) {
    const day = daysAgo(back)
    const date = iso(day)
    // Sunday is quiet, Saturday is busy -- a flat line reads as fake.
    const weekday = day.getDay()
    const count = weekday === 0 ? between(4, 7) : weekday === 6 ? between(14, 20) : between(8, 14)

    for (let n = 0; n < count; n++) {
      const serviceId = pick(serviceIds)
      const staffUserId = pick(stylists)
      const customerId = pick(customerIds)
      const hour = between(9, 19)
      const startsAt = `${date}T${String(hour).padStart(2, '0')}:${rnd() < 0.5 ? '00' : '30'}`

      let bookingId: string | null = null
      try {
        bookingId = await createBooking({
          organizationId: orgId, teamId, serviceId, customerId, date, startsAt,
          staffUserId, includePast: true, status: 'confirmed',
        })
      } catch {
        // SLOT_TAKEN: the double-booking constraint doing its job on random
        // data. Skip rather than retry -- a gap in a demo day is realistic.
        continue
      }

      // Most appointments are paid; a few are no-shows or cancellations, so
      // the booking funnel in §5.6 has something to show.
      const roll = rnd()
      if (roll < 0.06) {
        await pool.query(`update bookings set status = 'no_show' where id = $1`, [bookingId])
        continue
      }
      if (roll < 0.10) {
        await pool.query(`update bookings set status = 'cancelled' where id = $1`, [bookingId])
        continue
      }

      const items: Parameters<typeof checkout>[0]['items'] = [
        { serviceId, quantity: 1, discount: 0, staffUserId },
      ]
      // Roughly a fifth of visits also buy something off the shelf.
      if (rnd() < 0.2) {
        items.push({ productId: pick(productIds), quantity: 1, discount: 0 })
      }
      await checkout({
        organizationId: orgId, teamId, userId: staffIds['Dewi Anggraini'],
        items, customerId, bookingId, method: pick(['cash', 'qris', 'transfer', 'debit']),
        completedAt: `${date} ${String(hour).padStart(2, '0')}:45`,
      })
      sales++
    }
  }

  // The historic shift is closed, so three weeks of takings are locked -- and
  // the transactions page does not claim a shift has been open since the
  // beginning of the demo.
  await pool.query(
    `update shifts set closed_at = now() where team_id = $1 and closed_at is null`, [teamId])

  console.log('upcoming bookings…')
  let upcoming = 0
  for (let ahead = 0; ahead <= 6; ahead++) {
    const date = iso(daysAgo(-ahead))
    for (let n = 0; n < between(3, 8); n++) {
      try {
        await createBooking({
          organizationId: orgId, teamId, serviceId: pick(serviceIds),
          customerId: pick(customerIds), date,
          startsAt: `${date}T${String(between(9, 18)).padStart(2, '0')}:${rnd() < 0.5 ? '00' : '30'}`,
          staffUserId: pick(stylists), includePast: true,
          status: rnd() < 0.6 ? 'confirmed' : 'pending',
        })
        upcoming++
      } catch { /* SLOT_TAKEN -- see above */ }
    }
  }

  const { rows: [totals] } = await pool.query(
    `select coalesce(sum(total), 0)::bigint revenue from transactions
      where organization_id = $1 and status <> 'open'`, [orgId])

  console.log('')
  console.log(`  salon      Ovarya Salon & Spa  (${SLUG}.<apex>/book)`)
  console.log(`  sign in    ${ownerEmail} / ${PW}`)
  console.log(`  seeded     ${STAFF.length + 1} staff, ${SERVICES.length} services,` +
    ` ${customerIds.length} customers`)
  console.log(`             ${sales} sales, ${upcoming} upcoming bookings`)
  console.log(`  revenue    Rp ${Number(totals.revenue).toLocaleString('id-ID')}`)
  await pool.end()
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
