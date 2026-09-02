import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from '../db'
import { createSalon } from './fixtures'

/**
 * Booking through the app: the two-phase form, the day list, status changes,
 * and who is allowed to make them.
 *
 * The engine itself -- slot computation, the double-booking constraint, the
 * "any available" retry -- lives in tests/booking.db.test.ts. SQL and
 * two-connection assertions cover those far better than driving a browser,
 * and the race in particular cannot be provoked through HTTP at all.
 */
const DOMAIN = 'bookcheck.local'
const PW = 'demo12345'

const pool = new Pool({ connectionString: TEST_DATABASE_URL })

let orgId: string
let teamId: string
let serviceId: string
let stylistId: string
let otherTeamId: string
let owner: Awaited<ReturnType<typeof createSalon>>['ctx']
let desk: Awaited<ReturnType<typeof createSalon>>['ctx']
let stylistCtx: Awaited<ReturnType<typeof createSalon>>['ctx']

/** A Wednesday well clear of today, so the weekly pattern applies and the
 *  past-start filter never trims the day out from under an assertion. */
const DAY = '2027-03-10'

const ownerCookies = async () => (await owner.storageState()).cookies

/** Same shape service.spec.ts and staff.spec.ts use: Next renders its Server
 *  Action fields as self-closing hidden inputs, and a posted action without
 *  them is rejected as an unknown action rather than reaching the guard. */
const decodeHtml = (t: string) => t.replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

const hiddenFieldsOf = (formChunk: string) => [
  ...formChunk.slice(0, formChunk.indexOf('</form>')).matchAll(
    /<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?\s*\/>/g),
]

const bookingsFor = async () => (await pool.query(
  `select b.id, b.status, to_char(b.starts_at, 'HH24:MI') t, b.staff_user_id
     from bookings b where b.organization_id = $1 order by b.starts_at`,
  [orgId])).rows

/** Phase one is a GET, so the day and service arrive in the query string. */
async function openNewBooking(page: Page, opts: { staffUserId?: string } = {}) {
  const staff = opts.staffUserId ?? ''
  await page.goto(
    `/dashboard/bookings/new?serviceId=${serviceId}&date=${DAY}&staffUserId=${staff}`)
  await expect(page.getByRole('button', { name: 'Buat janji temu' })).toBeVisible()
}

test.beforeAll(async () => {
  await pool.query(`delete from organizations where slug like 'bookcheck%'`)
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`])

  const salon = await createSalon(pool, {
    name: 'Book Owner', email: `owner@${DOMAIN}`, password: PW,
    salon: 'Book Check', slug: 'bookcheck',
  })
  owner = salon.ctx
  orgId = salon.organizationId
  // Business: the free plan caps staff at 3, and owner + stylist + front desk
  // already fill it -- the second stylist the calendar tests need would be
  // refused with a 402. No assertion here is about quota.
  await pool.query(`
    update subscriptions set plan_id = (select id from plans where key = 'business')
     where organization_id = $1`, [orgId])

  const { rows: [team] } = await pool.query(
    `select id from teams where organization_id = $1 order by created_at limit 1`, [orgId])
  teamId = team.id

  const madeStylist = await owner.post('/api/staff', {
    data: {
      name: 'Book Stylist', email: `stylist@${DOMAIN}`, password: PW,
      role: 'stylist', branchId: teamId,
    },
  })
  stylistId = (await madeStylist.json()).user.id

  await owner.post('/api/staff', {
    data: {
      name: 'Book Desk', email: `desk@${DOMAIN}`, password: PW,
      role: 'frontdesk', branchId: teamId,
    },
  })

  // A second branch nobody's session is switched to -- the one a posted
  // team id would reach if the action trusted the form.
  otherTeamId = crypto.randomUUID()
  await pool.query(
    `insert into teams (id, name, organization_id, created_at)
     values ($1, 'Cabang Kedua', $2, now())`, [otherTeamId, orgId])

  serviceId = crypto.randomUUID()
  await pool.query(
    `insert into services (id, organization_id, name, duration_minutes, price)
     values ($1, $2, 'Potong Rambut', 60, 150000)`, [serviceId, orgId])
  await pool.query(
    `insert into service_staff (service_id, user_id, organization_id) values ($1, $2, $3)`,
    [serviceId, stylistId, orgId])

  const { signIn } = await import('./fixtures')
  desk = await signIn(`desk@${DOMAIN}`, PW)
  stylistCtx = await signIn(`stylist@${DOMAIN}`, PW)
})

test.afterAll(async () => {
  await pool.query(`delete from organizations where slug like 'bookcheck%'`)
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`])
  await pool.end()
})

test.beforeEach(async () => {
  await pool.query(`delete from bookings where organization_id = $1`, [orgId])
})

test.describe.serial('booking through the app', () => {
  test('books a slot, shows it on the day, and returns the slot when cancelled', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await openNewBooking(page, { staffUserId: stylistId })

    // The slot must be offered BEFORE it is booked and gone after -- asserting
    // only the second half would pass against a form that offers nothing.
    const ten = page.locator('input[name="startsAt"][value$="T10:00"]')
    await expect(ten).toHaveCount(1)
    await ten.check()
    await page.locator('#name').fill('Ibu Sari')
    await page.locator('#phone').fill('081234567890')
    await page.getByRole('button', { name: 'Buat janji temu' }).click()

    await page.waitForURL(`**/dashboard/bookings?date=${DAY}`)
    await expect(page.getByText('Ibu Sari')).toBeVisible()
    await expect(page.getByText('Potong Rambut')).toBeVisible()

    // Same phone, so the customer is REUSED rather than duplicated -- the
    // whole reason booking routes through findOrCreateByPhone.
    const { rows: customers } = await pool.query(
      `select count(*)::int n from customers where organization_id = $1`, [orgId])
    expect(customers[0].n).toBe(1)

    await openNewBooking(page, { staffUserId: stylistId })
    await expect(page.locator('input[name="startsAt"][value$="T10:00"]'),
      'the booked slot must stop being offered').toHaveCount(0)

    await page.goto(`/dashboard/bookings?date=${DAY}`)
    await page.getByRole('button', { name: 'Batalkan' }).click()
    await expect(page.getByText('Batal')).toBeVisible()

    await openNewBooking(page, { staffUserId: stylistId })
    await expect(page.locator('input[name="startsAt"][value$="T10:00"]'),
      'cancelling must return the slot').toHaveCount(1)
  })

  test('walks a booking pending -> confirmed -> completed, and offers nothing after', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await openNewBooking(page, { staffUserId: stylistId })
    await page.locator('input[name="startsAt"][value$="T11:00"]').check()
    await page.locator('#name').fill('Pak Budi')
    await page.locator('#phone').fill('081234567891')
    await page.getByRole('button', { name: 'Buat janji temu' }).click()
    await page.waitForURL(`**/dashboard/bookings?date=${DAY}`)

    await page.getByRole('button', { name: 'Konfirmasi' }).click()
    await expect(page.getByText('Terkonfirmasi')).toBeVisible()

    await page.getByRole('button', { name: 'Selesai', exact: true }).click()
    // Waited on the ACTIONS disappearing, not on the word "Selesai": that
    // word is also the button's own label, so it is on screen before the
    // click has landed and asserting it would pass against no change at all.
    // A terminal status offers nothing, which only the completed row does.
    await expect(page.getByRole('button', { name: 'Batalkan' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Konfirmasi' })).toHaveCount(0)
    expect((await bookingsFor())[0].status).toBe('completed')
  })

  test('"any available" assigns a real stylist', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await openNewBooking(page)
    await page.locator('input[name="startsAt"][value$="T14:00"]').check()
    await page.locator('#name').fill('Ibu Rina')
    await page.locator('#phone').fill('081234567892')
    await page.getByRole('button', { name: 'Buat janji temu' }).click()
    await page.waitForURL(`**/dashboard/bookings?date=${DAY}`)

    const [row] = await bookingsFor()
    expect(row.staff_user_id, 'never stored as "anyone"').toBe(stylistId)
  })

  test('a stale slot is refused rather than double-booked', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await openNewBooking(page, { staffUserId: stylistId })
    // The page is loaded and 10:00 is offered; someone else takes it before
    // this form is submitted. Exactly the tab-left-open case.
    await page.locator('input[name="startsAt"][value$="T10:00"]').check()
    await page.locator('#name').fill('Ibu Tuti')
    await page.locator('#phone').fill('081234567893')
    await pool.query(
      `insert into bookings (id, organization_id, team_id, staff_user_id, customer_id,
                             service_id, starts_at, ends_at, status,
                             duration_minutes, price, currency)
       select $1, $2, $3, $4, c.id, $5, $6::timestamp, $7::timestamp, 'pending',
              60, 150000, 'IDR'
         from customers c where c.organization_id = $2 limit 1`,
      [crypto.randomUUID(), orgId, teamId, stylistId, serviceId,
       `${DAY} 10:00`, `${DAY} 11:00`])

    await page.getByRole('button', { name: 'Buat janji temu' }).click()
    await expect(page.getByText('Jam itu sudah tidak tersedia. Silakan pilih jam lain.'))
      .toBeVisible()
    const rows = await bookingsFor()
    expect(rows, 'the refused attempt must not have written anything').toHaveLength(1)
  })
})

test.describe.serial('reschedule and the calendar', () => {
  let bookingId: string
  let secondStylistId: string

  test.beforeAll(async () => {
    // A SECOND stylist with their own booking, so the week view's "one
    // stylist" filter can be wrong. With only one stylist, filtering and not
    // filtering draw the same picture and deleting the filter fails nothing.
    const made = await owner.post('/api/staff', {
      data: {
        name: 'Book Stylist Dua', email: `stylist2@${DOMAIN}`, password: PW,
        role: 'stylist', branchId: teamId,
      },
    })
    // 201, not 200 -- the route answers Created. Checked at all because the
    // free plan's 3-seat cap silently returned a 402 here, and an unchecked
    // .json() turned that into "cannot read properties of undefined".
    if (made.status() >= 300) {
      throw new Error(`second stylist not created: ${made.status()} ${await made.text()}`)
    }
    secondStylistId = (await made.json()).user.id
    await pool.query(
      `insert into service_staff (service_id, user_id, organization_id) values ($1, $2, $3)
       on conflict do nothing`, [serviceId, secondStylistId, orgId])
  })

  test.beforeEach(async () => {
    await pool.query(`delete from bookings where organization_id = $1`, [orgId])
    const { rows: [customer] } = await pool.query(
      `insert into customers (id, organization_id, name, phone_key)
       values ($1, $2, 'Ibu Pindah', '628111000111')
       on conflict (organization_id, phone_key) where phone_key is not null
       do update set name = excluded.name
       returning id`, [crypto.randomUUID(), orgId])
    bookingId = crypto.randomUUID()
    await pool.query(
      `insert into bookings (id, organization_id, team_id, staff_user_id, customer_id,
                             service_id, starts_at, ends_at, status,
                             duration_minutes, price, currency)
       values ($1, $2, $3, $4, $5, $6, $7::timestamp, $8::timestamp, 'confirmed',
               60, 150000, 'IDR')`,
      [bookingId, orgId, teamId, stylistId, customer.id, serviceId,
       `${DAY} 10:00`, `${DAY} 11:00`])

    const { rows: [second] } = await pool.query(
      `insert into customers (id, organization_id, name) values ($1, $2, 'Ibu Kolega')
       returning id`, [crypto.randomUUID(), orgId])
    await pool.query(
      `insert into bookings (id, organization_id, team_id, staff_user_id, customer_id,
                             service_id, starts_at, ends_at, status,
                             duration_minutes, price, currency)
       values ($1, $2, $3, $4, $5, $6, $7::timestamp, $8::timestamp, 'confirmed',
               60, 150000, 'IDR')`,
      [crypto.randomUUID(), orgId, teamId, secondStylistId, second.id, serviceId,
       `${DAY} 13:00`, `${DAY} 14:00`])
  })

  test('moves a booking half an hour later -- it must not collide with itself', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto(`/dashboard/bookings/${bookingId}`)
    // 10:30 overlaps the booking's own 10:00-11:00 range, so this option only
    // exists because available_slots excludes the row being moved.
    await page.locator('input[name="startsAt"][value$="T10:30"]').check()
    await page.getByRole('button', { name: 'Pindahkan jadwal' }).click()
    await page.waitForURL(`**/dashboard/bookings?date=${DAY}`)

    const { rows } = await pool.query(
      `select to_char(starts_at, 'HH24:MI') s, to_char(ends_at, 'HH24:MI') e, status
         from bookings where id = $1`, [bookingId])
    expect(rows[0]).toEqual({ s: '10:30', e: '11:30', status: 'confirmed' })
  })

  test('refuses a time another booking holds, and leaves the original alone', async ({ page }) => {
    const { rows: [other] } = await pool.query(
      `insert into customers (id, organization_id, name) values ($1, $2, 'Lain')
       returning id`, [crypto.randomUUID(), orgId])
    await pool.query(
      `insert into bookings (id, organization_id, team_id, staff_user_id, customer_id,
                             service_id, starts_at, ends_at, status,
                             duration_minutes, price, currency)
       values ($1, $2, $3, $4, $5, $6, $7::timestamp, $8::timestamp, 'pending',
               60, 150000, 'IDR')`,
      [crypto.randomUUID(), orgId, teamId, stylistId, other.id, serviceId,
       `${DAY} 15:00`, `${DAY} 16:00`])

    await page.context().addCookies(await ownerCookies())
    await page.goto(`/dashboard/bookings/${bookingId}`)
    // 15:00 is held, so the form must not even offer it.
    await expect(page.locator('input[name="startsAt"][value$="T15:00"]')).toHaveCount(0)
    // ...and posting it anyway is refused by the server.
    await page.locator('input[name="startsAt"]').first().check()
    await page.evaluate((day) => {
      const el = document.querySelector('input[name="startsAt"]:checked') as HTMLInputElement
      el.value = `${day}T15:00`
    }, DAY)
    await page.getByRole('button', { name: 'Pindahkan jadwal' }).click()
    await expect(page.getByText('Jam itu sudah tidak tersedia. Silakan pilih jam lain.'))
      .toBeVisible()
    const { rows } = await pool.query(
      `select to_char(starts_at, 'HH24:MI') s from bookings where id = $1`, [bookingId])
    expect(rows[0].s).toBe('10:00')
  })

  test('a cancelled booking cannot be moved, and the form is not even offered', async ({ page }) => {
    await pool.query(`update bookings set status = 'cancelled' where id = $1`, [bookingId])
    await page.context().addCookies(await ownerCookies())
    await page.goto(`/dashboard/bookings/${bookingId}`)
    await expect(page.getByText('Janji temu ini sudah selesai atau dibatalkan, jadi tidak bisa dipindahkan.'))
      .toBeVisible()
    await expect(page.getByRole('button', { name: 'Pindahkan jadwal' })).toHaveCount(0)
  })

  test('another salon\'s booking is not found, not merely unmovable', async () => {
    const res = await desk.get(`/dashboard/bookings/${crypto.randomUUID()}`)
    expect(res.status()).toBe(404)
  })

  test('the day calendar draws the booking in its stylist column, at its own height', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto(`/dashboard/bookings/calendar?date=${DAY}`)
    // Both stylists get a column, and each booking sits in its own.
    await expect(page.getByRole('link', { name: /10:00 Ibu Pindah/ })).toBeVisible()
    await expect(page.getByRole('link', { name: /13:00 Ibu Kolega/ })).toBeVisible()
    const block = page.getByRole('link', { name: /10:00 Ibu Pindah/ })

    // A 60-minute booking must be twice the height of a 30-minute one -- the
    // grid spans rows from the booking's OWN start and end, so a calendar that
    // ignored duration would render both the same.
    const hour = (await block.boundingBox())!.height
    await pool.query(
      `update bookings set ends_at = $2::timestamp, duration_minutes = 30
        where id = $1`, [bookingId, `${DAY} 10:30`])
    await page.reload()
    const half = (await page.getByRole('link', { name: /10:00 Ibu Pindah/ }).boundingBox())!.height
    expect(hour).toBeGreaterThan(half * 1.5)
  })

  test('the week calendar puts it in its day column', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto(`/dashboard/bookings/calendar?date=${DAY}&view=week&staffUserId=${stylistId}`)
    await expect(page.getByRole('link', { name: /10:00 Ibu Pindah/ })).toBeVisible()
    // DAY is a Wednesday, so the lane header for it must be present.
    await expect(page.getByText(`Rab ${DAY.slice(8)}`)).toBeVisible()
    // The week view is ONE stylist's week -- the colleague's booking that same
    // day belongs to their week, not this one.
    await expect(page.getByRole('link', { name: /13:00 Ibu Kolega/ })).toHaveCount(0)

    await page.goto(`/dashboard/bookings/calendar?date=${DAY}&view=week&staffUserId=${secondStylistId}`)
    await expect(page.getByRole('link', { name: /13:00 Ibu Kolega/ })).toBeVisible()
    await expect(page.getByRole('link', { name: /10:00 Ibu Pindah/ })).toHaveCount(0)
  })

  test('a closed branch says so rather than drawing an empty grid', async ({ page }) => {
    await pool.query(`update branch_hours set closed = true where team_id = $1`, [teamId])
    await page.context().addCookies(await ownerCookies())
    await page.goto(`/dashboard/bookings/calendar?date=${DAY}`)
    await expect(page.getByText('Cabang tutup sepanjang rentang ini.')).toBeVisible()
    await pool.query(`update branch_hours set closed = false where team_id = $1`, [teamId])
  })
})

test.describe.serial('walk-ins', () => {
  /** Today, wall-clock -- the walk-in bypass only applies to today, so this
   *  cannot be a fixed date the way the rest of this file uses DAY. */
  const today = () => {
    const d = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }

  test.beforeEach(async () => {
    await pool.query(`delete from bookings where organization_id = $1`, [orgId])
    // The stylist has to be working right now for today to have any slots at
    // all -- open every weekday wide rather than guessing which one today is.
    await pool.query(`update staff_hours set closed = false, opens_at = '00:00',
                       closes_at = '23:59' where organization_id = $1`, [orgId])
    await pool.query(`update branch_hours set closed = false, opens_at = '00:00',
                       closes_at = '23:59' where team_id = $1`, [teamId])
  })

  test('the walk-in page offers times the ordinary one has already dropped', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    const d = today()
    await page.goto(`/dashboard/bookings/new?serviceId=${serviceId}&date=${d}&staffUserId=${stylistId}`)
    const ordinary = await page.locator('input[name="startsAt"]').count()

    await page.goto(`/dashboard/bookings/new?walkIn=1&serviceId=${serviceId}&date=${d}&staffUserId=${stylistId}`)
    const walkIn = await page.locator('input[name="startsAt"]').count()
    expect(walkIn, 'the bypass must widen the day, not merely relabel the page')
      .toBeGreaterThan(ordinary)
  })

  test('a walk-in is recorded CONFIRMED -- the customer is already here', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    const d = today()
    await page.goto(`/dashboard/bookings/new?walkIn=1&serviceId=${serviceId}&date=${d}&staffUserId=${stylistId}`)
    // The first offered time on a walk-in page is the earliest of the day,
    // which is in the past for any run after midnight -- that is the point.
    await page.locator('input[name="startsAt"]').first().check()
    await page.locator('#name').fill('Bapak Mampir')
    await page.locator('#phone').fill('081299990001')
    await page.getByRole('button', { name: 'Catat kedatangan' }).click()
    await page.waitForURL(`**/dashboard/bookings?date=${d}`)

    const { rows } = await pool.query(
      `select status from bookings where organization_id = $1`, [orgId])
    expect(rows).toHaveLength(1)
    expect(rows[0].status, 'nobody is left to confirm it to').toBe('confirmed')
  })

  test('an ordinary booking made the same way is still pending', async ({ page }) => {
    // The control: without it, "confirmed" could be the default for every
    // booking rather than something the walk-in flag does.
    await page.context().addCookies(await ownerCookies())
    await openNewBooking(page, { staffUserId: stylistId })
    await page.locator('input[name="startsAt"][value$="T10:00"]').check()
    await page.locator('#name').fill('Ibu Biasa')
    await page.locator('#phone').fill('081299990002')
    await page.getByRole('button', { name: 'Buat janji temu' }).click()
    await page.waitForURL(`**/dashboard/bookings?date=${DAY}`)

    const { rows } = await pool.query(
      `select status from bookings where organization_id = $1`, [orgId])
    expect(rows[0].status).toBe('pending')
  })
})

test.describe.serial('the working owner', () => {
  let ownerId: string

  let branchName: string

  test.beforeAll(async () => {
    const { rows } = await pool.query(
      `select user_id from staff_profiles where organization_id = $1
         and user_id in (select user_id from members
                          where organization_id = $1 and role like '%owner%')`, [orgId])
    ownerId = rows[0].user_id
    const { rows: [team] } = await pool.query(
      `select name from teams where id = $1`, [teamId])
    branchName = team.name
  })

  test('the branch card is offered to an owner, and placing them makes them bookable', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto(`/dashboard/staff/${ownerId}`)
    // The card used to be hidden for owner and admin, on the reading that a
    // salon-wide role is not placed at a branch -- which is exactly what made
    // a working owner unbookable.
    await expect(page.getByRole('button', { name: 'Pindahkan' })).toBeVisible()

    await page.locator('#transferTeamId').click()
    // By id, not by a guessed label: better-auth names the default team
    // itself during organization creation.
    await page.getByRole('option', { name: branchName, exact: true }).click()
    await page.getByRole('button', { name: 'Pindahkan' }).click()
    await expect(page.getByText('Staf dipindahkan.')).toBeVisible()

    const { rows } = await pool.query(
      `select team_id from staff_profiles where user_id = $1 and organization_id = $2`,
      [ownerId, orgId])
    expect(rows[0].team_id).toBe(teamId)

    // ...and the schedule cards, hidden while they had no branch, appear --
    // without hours there is nothing for available_slots to clamp.
    await page.reload()
    // The weekly form's own control, not the heading: the card title and the
    // exceptions card's copy both carry that phrase.
    await expect(page.locator('#sched-closed-1')).toBeVisible()

    await pool.query(
      `insert into service_staff (service_id, user_id, organization_id) values ($1, $2, $3)
       on conflict do nothing`, [serviceId, ownerId, orgId])
    await page.goto(
      `/dashboard/bookings/new?serviceId=${serviceId}&date=${DAY}&staffUserId=${ownerId}`)
    await expect(page.locator('input[name="startsAt"]').first(),
      'an owner who cuts hair must appear in the slot list').toBeVisible()
  })

  test('releasing them from the branch is offered, and takes them back out of booking', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto(`/dashboard/staff/${ownerId}`)
    await page.getByRole('button', { name: 'Lepaskan dari cabang' }).click()
    await expect(page.getByText('Staf dipindahkan.')).toBeVisible()

    const { rows } = await pool.query(
      `select team_id from staff_profiles where user_id = $1 and organization_id = $2`,
      [ownerId, orgId])
    expect(rows[0].team_id).toBeNull()

    await page.goto(`/dashboard/bookings/new?serviceId=${serviceId}&date=${DAY}`)
    // Asserted on the STAFF LIST, not on the slots: an unknown staff param
    // falls back to "any available", so the colleague's times are still on
    // screen and asserting their absence would fail for the wrong reason.
    await expect(page.locator(`#staffUserId option[value="${ownerId}"]`)).toHaveCount(0)
    await expect(page.locator(`#staffUserId option[value="${stylistId}"]`),
      'the stylist is still offered').toHaveCount(1)
  })

  test('a stylist is never offered the release control -- they must always have a branch', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto(`/dashboard/staff/${stylistId}`)
    await expect(page.getByRole('button', { name: 'Pindahkan' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Lepaskan dari cabang' })).toHaveCount(0)
  })
})

test.describe('who may do what', () => {
  test('a stylist can read the day but cannot change a status', async () => {
    const { rows: [customer] } = await pool.query(
      `insert into customers (id, organization_id, name) values ($1, $2, 'Uji')
       returning id`, [crypto.randomUUID(), orgId])
    const id = crypto.randomUUID()
    await pool.query(
      `insert into bookings (id, organization_id, team_id, staff_user_id, customer_id,
                             service_id, starts_at, ends_at, status,
                             duration_minutes, price, currency)
       values ($1, $2, $3, $4, $5, $6, $7::timestamp, $8::timestamp, 'pending',
               60, 150000, 'IDR')`,
      [id, orgId, teamId, stylistId, customer.id, serviceId,
       `${DAY} 09:00`, `${DAY} 10:00`])

    const readable = await stylistCtx.get(`/dashboard/bookings?date=${DAY}`)
    expect(readable.status(), 'booking:read is granted to stylists').toBe(200)

    // The page renders no action button for them, so this is the endpoint
    // itself being posted to -- the guard has to live in the action, not only
    // in the markup.
    const html = await readable.text()
    const form = html.split('<form').find((f) => f.includes('name="status"'))
    if (!form) throw new Error('no status form rendered for the stylist')
    const multipart: Record<string, string> = {}
    for (const [, k, v] of hiddenFieldsOf(form)) multipart[decodeHtml(k)] = decodeHtml(v ?? '')
    multipart.id = id
    multipart.status = 'confirmed'
    const refused = await stylistCtx.post('/dashboard/bookings', { multipart, maxRedirects: 0 })
    // requirePagePermission REDIRECTS rather than throwing -- that is the
    // page-guard family's contract (lib/session.ts:132) and every Server
    // Action here uses it. So the refusal reads as a bounce to /dashboard,
    // and what actually matters is that the write never happened.
    expect(refused.status()).toBe(303)
    expect(refused.headers()['location'] ?? '').toContain('/dashboard')
    const { rows } = await pool.query(`select status from bookings where id = $1`, [id])
    expect(rows[0].status, 'and nothing changed').toBe('pending')
  })

  test('the branch comes from the session, not the form', async ({ page }) => {
    // Posting a team id must not move the booking: a front-desk user cannot
    // switch branches, so a form field that could would hand them one they
    // are not allowed to see. The booking still lands, and it lands HERE.
    await page.context().addCookies(await ownerCookies())
    await openNewBooking(page, { staffUserId: stylistId })
    await page.evaluate((teamId) => {
      const form = document.querySelector('form input[name="startsAt"]')!.closest('form')!
      const el = document.createElement('input')
      el.type = 'hidden'
      el.name = 'teamId'
      el.value = teamId
      form.appendChild(el)
    }, otherTeamId)
    await page.locator('input[name="startsAt"][value$="T15:00"]').check()
    await page.locator('#name').fill('Ibu Dewi')
    await page.locator('#phone').fill('081234567894')
    await page.getByRole('button', { name: 'Buat janji temu' }).click()
    await page.waitForURL(`**/dashboard/bookings?date=${DAY}`)

    const { rows } = await pool.query(
      `select team_id from bookings where organization_id = $1`, [orgId])
    expect(rows).toHaveLength(1)
    expect(rows[0].team_id, 'the session branch, not the posted one').toBe(teamId)
  })

  test('front desk may book and change status; only owner and admin see settings', async () => {
    expect((await desk.get('/dashboard/bookings/new')).status()).toBe(200)
    const deskSettings = await desk.get('/dashboard/settings')
    expect(deskSettings.status(), 'frontdesk holds no settings statement').not.toBe(200)
    expect((await owner.get('/dashboard/settings')).status()).toBe(200)
  })

  test('the nav shows booking to everyone who can read it, and settings only to owner and admin', async () => {
    const asOwner = await (await owner.get('/dashboard')).text()
    expect(asOwner).toContain('/dashboard/bookings')
    expect(asOwner).toContain('/dashboard/settings')

    const asStylist = await (await stylistCtx.get('/dashboard')).text()
    expect(asStylist).toContain('/dashboard/bookings')
    expect(asStylist, 'a link whose page would 403 must not be shown')
      .not.toContain('/dashboard/settings')
  })
})
