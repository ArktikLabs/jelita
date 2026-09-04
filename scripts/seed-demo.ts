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

/**
 * Two branches, because §5.8 is a selling point and a one-branch demo shows
 * none of it: no branch selector worth using, no per-branch revenue split, and
 * no way to see that a stylist is bound to one salon.
 *
 * Senopati is the newer, smaller shop -- see WEIGHT below.
 */
const BRANCHES: [string, string, string][] = [
  ['Ovarya Kemang', 'Jl. Kemang Raya No. 42, Jakarta Selatan', '021-7180042'],
  ['Ovarya Senopati', 'Jl. Senopati No. 18, Jakarta Selatan', '021-7205511'],
]

/** Branch B does roughly 60% of A's trade. A dead-even split reads as fake. */
const WEIGHT = [1, 0.6]

/**
 * The third field is the branch index, or null for management.
 *
 * Every branch needs its OWN front desk: staff_profiles.team_id binds a person
 * to one salon, so a single cashier could not have rung up both shops.
 */
const STAFF: [string, string, number | null][] = [
  ['Sinta Dewi', 'stylist', 0],
  ['Rina Marlina', 'stylist', 0],
  ['Dewi Anggraini', 'frontdesk', 0],
  ['Ayu Lestari', 'stylist', 1],
  ['Bella Kartika', 'stylist', 1],
  ['Sari Wulandari', 'frontdesk', 1],
  ['Putri Handayani', 'admin', null],
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

  /**
   * Delete rows an immutability trigger exists to protect.
   *
   * Re-seeding is the ONLY legitimate caller. Every one of these triggers is
   * doing its job -- a settled sale, a stock movement and a sent message are
   * all records of things that happened -- and wiping a demo salon is the one
   * operation that is allowed to disagree.
   */
  const withoutTriggers = async (
    pairs: [table: string, trigger: string][], fn: () => Promise<void>,
  ) => {
    for (const [t, g] of pairs) await pool.query(`alter table ${t} disable trigger ${g}`)
    try {
      await fn()
    } finally {
      for (const [t, g] of pairs) await pool.query(`alter table ${t} enable trigger ${g}`)
    }
  }

  const { rows: prior } = await pool.query(
    `select id from organizations where slug = $1`, [SLUG])
  if (prior[0]) {
    const org = prior[0].id
    // ALL of them, off together. Lines and payments follow their parent and
    // their triggers refuse a delete whenever that parent is settled;
    // commissions reuse the very same function, which is what re-seeding
    // actually tripped on. Turning them off one at a time in delete order is
    // how the previous version missed two of the four.
    await withoutTriggers([
      ['transaction_lines', 'transaction_lines_settled_immutable'],
      ['transaction_payments', 'transaction_payments_settled_immutable'],
      ['commissions', 'commissions_settled_immutable'],
      ['transactions', 'transactions_settled_immutable'],
      ['stock_movements', 'stock_movements_append_only'],
      ['customer_points', 'customer_points_settled_immutable'],
    ], async () => {
      await pool.query(`delete from transaction_payments where organization_id = $1`, [org])
      await pool.query(`delete from commissions where organization_id = $1`, [org])
      await pool.query(`delete from transaction_lines where organization_id = $1`, [org])
      await pool.query(`delete from transactions where organization_id = $1`, [org])
      await pool.query(`delete from stock_movements where organization_id = $1`, [org])
    })
  }
  // The organization cascade reaches notifications, and a SENT one is
  // immutable too.
  await withoutTriggers([['notifications', 'notifications_sent_immutable']], async () => {
    await pool.query(`delete from organizations where slug = $1`, [SLUG])
  })
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

  const teamIds: string[] = []
  for (const [name, address, phone] of BRANCHES) {
    const id = crypto.randomUUID()
    teamIds.push(id)
    await pool.query(
      `insert into teams (id, name, organization_id, created_at) values ($1, $2, $3, now())`,
      [id, name, orgId])
    // branch_profiles and branch_hours are seeded by trigger; only the
    // address and phone are ours to fill in.
    await pool.query(
      `update branch_profiles set address = $2, phone = $3 where team_id = $1`,
      [id, address, phone])
  }

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
  const staffBranch: Record<string, number | null> = {}
  for (const [name, role, branch] of STAFF) {
    staffBranch[name] = branch
    const email = `${name.split(' ')[0].toLowerCase()}@${DOMAIN}`
    staffIds[name] = await createLogin(pool, ctx, { name, email })
    await pool.query(
      `insert into members (id, user_id, organization_id, role, created_at)
       values ($1, $2, $3, $4, now())`,
      [crypto.randomUUID(), staffIds[name], orgId, role])
    if (branch !== null) {
      // The members insert seeds staff_profiles (and staff_hours) by trigger;
      // the branch assignment is a separate write.
      await pool.query(`update staff_profiles set team_id = $1
                         where user_id = $2 and organization_id = $3`,
        [teamIds[branch], staffIds[name], orgId])
      await pool.query(
        `insert into team_members (id, team_id, user_id, created_at)
         values ($1, $2, $3, now())`,
        [crypto.randomUUID(), teamIds[branch], staffIds[name]])
    }
  }
  /** One roster per branch: a stylist is bound to one salon and cannot float. */
  const branches = BRANCHES.map(([name], i) => ({
    name,
    teamId: teamIds[i],
    weight: WEIGHT[i],
    stylists: STAFF.filter(([, r, b]) => r === 'stylist' && b === i).map(([n]) => staffIds[n]),
    cashier: staffIds[STAFF.find(([, r, b]) => r === 'frontdesk' && b === i)![0]],
  }))
  // The owner works the floor -- the common case in a salon this size, and the
  // gap the staff model was changed to allow.
  await pool.query(`update staff_profiles set team_id = $1
                     where user_id = $2 and organization_id = $3`,
    [teamIds[0], owner.id, orgId])
  // AND a team_members row, which is what lib/auth.ts's session hook reads to
  // set activeTeamId. Without it the owner signs in with no active branch and
  // every branch-scoped screen -- the dashboard included -- shows nothing.
  //
  // Found by screenshotting the seeded dashboard, not by any test: the e2e
  // suites build their salons through createSalon, which goes via better-auth
  // and gets this row for free. A seed that writes the rows itself does not.
  await pool.query(
    `insert into team_members (id, team_id, user_id, created_at)
     values ($1, $2, $3, now())`, [crypto.randomUUID(), teamIds[0], owner.id])
  branches[0].stylists.push(owner.id)
  const stylists = branches.flatMap((b) => b.stylists)

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
    // Every stylist can perform everything, except the long chemical
    // treatments, which only the senior at each branch does. ONE PER BRANCH,
    // not the two most senior overall: both of those work at Kemang, and
    // Senopati would silently never offer a keratin treatment.
    const eligible = minutes >= 150
      ? branches.map((b) => b.stylists[0])
      : stylists
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
    // Stock is BRANCH-scoped: each shop opens with its own shelf.
    for (const b of branches) {
      await recordMovement({
        organizationId: orgId, teamId: b.teamId, productId: id,
        quantity: between(12, 30), reason: 'purchase', note: 'Stok awal',
      })
    }
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
    const busy = weekday === 0 ? between(4, 7) : weekday === 6 ? between(14, 20) : between(8, 14)

    for (const branch of branches) {
    const { teamId } = branch
    const count = Math.round(busy * branch.weight)
    for (let n = 0; n < count; n++) {
      const serviceId = pick(serviceIds)
      const staffUserId = pick(branch.stylists)
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
        organizationId: orgId, teamId, userId: branch.cashier,
        items, customerId, bookingId, method: pick(['cash', 'qris', 'transfer', 'debit']),
        completedAt: `${date} ${String(hour).padStart(2, '0')}:45`,
      })
      sales++
    }
    }
  }

  // The historic shift is closed, so three weeks of takings are locked -- and
  // the transactions page does not claim a shift has been open since the
  // beginning of the demo.
  await pool.query(
    `update shifts set closed_at = now() where team_id = any($1) and closed_at is null`,
    [teamIds])

  console.log('upcoming bookings…')
  let upcoming = 0
  for (let ahead = 0; ahead <= 6; ahead++) {
    const date = iso(daysAgo(-ahead))
    for (const branch of branches) {
      for (let n = 0; n < Math.round(between(3, 8) * branch.weight); n++) {
        try {
          await createBooking({
            organizationId: orgId, teamId: branch.teamId, serviceId: pick(serviceIds),
            customerId: pick(customerIds), date,
            startsAt: `${date}T${String(between(9, 18)).padStart(2, '0')}:${rnd() < 0.5 ? '00' : '30'}`,
            staffUserId: pick(branch.stylists), includePast: true,
            status: rnd() < 0.6 ? 'confirmed' : 'pending',
          })
          upcoming++
        } catch { /* SLOT_TAKEN -- see above */ }
      }
    }
  }

  // The three weeks of history queued notifications too, and every one of
  // them is now overdue -- a demo that opens the Notification Center on 849
  // pending WhatsApps is showing a backlog, not a pipeline. In a real salon
  // those went out on the day, so record them as having gone out. Only the
  // upcoming bookings' reminders stay queued, which is the state a demo
  // should open on.
  //
  // Keyed on whether the APPOINTMENT has happened, not on send_at: a
  // confirmation's send_at is the moment it was queued, which for backdated
  // bookings is when this script ran, so a send_at cut marks today's 232
  // confirmations due for visits that finished three weeks ago.
  const { rowCount: backdated } = await pool.query(
    `update notifications n
        set status = 'sent', sent_at = send_at, provider = 'log',
            provider_ref = 'log:' || gen_random_uuid()
      where n.organization_id = $1 and n.status = 'queued'
        and exists (select 1 from bookings b
                     where b.id = n.booking_id and b.ends_at < localtimestamp)`, [orgId])

  const { rows: [totals] } = await pool.query(
    `select coalesce(sum(total), 0)::bigint revenue from transactions
      where organization_id = $1 and status <> 'open'`, [orgId])

  console.log('')
  console.log(`  salon      Ovarya Salon & Spa  (${SLUG}.<apex>/book)`)
  console.log(`  sign in    ${ownerEmail} / ${PW}`)
  console.log(`  branches   ${BRANCHES.map(([n]) => n).join(', ')}`)
  console.log(`  seeded     ${STAFF.length + 1} staff, ${SERVICES.length} services,` +
    ` ${customerIds.length} customers`)
  console.log(`             ${sales} sales, ${upcoming} upcoming bookings`)
  console.log(`             ${backdated} notifications already sent`)
  console.log(`  revenue    Rp ${Number(totals.revenue).toLocaleString('id-ID')}`)
  await pool.end()
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
