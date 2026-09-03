import { expect, test } from '@playwright/test'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from '../db'
import { createSalon, signIn } from './fixtures'

/**
 * Checkout, the receipt, voiding, and the branding that rides on both.
 *
 * The ledger's guarantees (immutability, reversal signs, the shift window)
 * live in tests/pos.db.test.ts -- they hold against a direct statement, which
 * is what actually matters, and driving a browser would prove less.
 */
const DOMAIN = 'poscheck.local'
const PW = 'demo12345'

const pool = new Pool({ connectionString: TEST_DATABASE_URL })

let orgId: string
let teamId: string
let serviceId: string
let stylistId: string
let bookingId: string
let owner: Awaited<ReturnType<typeof createSalon>>['ctx']
let desk: Awaited<ReturnType<typeof signIn>>

const DAY = '2027-08-11'

const ownerCookies = async () => (await owner.storageState()).cookies
const deskCookies = async () => (await desk.storageState()).cookies

const sales = async () => (await pool.query(
  `select invoice_no, status, total, reverses_id from transactions
    where organization_id = $1 order by invoice_no`, [orgId])).rows

test.beforeAll(async () => {
  await pool.query(`delete from organizations where slug like 'poscheck%'`)
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`])

  const salon = await createSalon(pool, {
    name: 'Pos Owner', email: `owner@${DOMAIN}`, password: PW,
    salon: 'Pos Check', slug: 'poscheck',
  })
  owner = salon.ctx
  orgId = salon.organizationId
  const { rows: [team] } = await pool.query(
    `select id from teams where organization_id = $1 order by created_at limit 1`, [orgId])
  teamId = team.id

  const made = await owner.post('/api/staff', {
    data: {
      name: 'Pos Stylist', email: `stylist@${DOMAIN}`, password: PW,
      role: 'stylist', branchId: teamId,
    },
  })
  stylistId = (await made.json()).user.id
  await owner.post('/api/staff', {
    data: {
      name: 'Pos Desk', email: `desk@${DOMAIN}`, password: PW,
      role: 'frontdesk', branchId: teamId,
    },
  })
  desk = await signIn(`desk@${DOMAIN}`, PW)

  serviceId = crypto.randomUUID()
  await pool.query(
    `insert into services (id, organization_id, name, duration_minutes, price)
     values ($1, $2, 'Creambath', 60, 150000)`, [serviceId, orgId])
  await pool.query(
    `insert into service_staff (service_id, user_id, organization_id) values ($1, $2, $3)`,
    [serviceId, stylistId, orgId])
})

test.afterAll(async () => {
  await pool.query(`truncate transaction_payments, transaction_lines, transactions cascade`)
  await pool.query(`delete from organizations where slug like 'poscheck%'`)
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`])
  await pool.end()
})

test.beforeEach(async () => {
  await pool.query(`truncate transaction_payments, transaction_lines, transactions cascade`)
  await pool.query(`delete from shifts where organization_id = $1`, [orgId])
  await pool.query(`delete from bookings where organization_id = $1`, [orgId])
  await pool.query(`update salon_profiles set next_invoice_no = 1 where organization_id = $1`, [orgId])

  const { rows: [customer] } = await pool.query(
    `insert into customers (id, organization_id, name, phone, phone_key)
     values ($1, $2, 'Ibu Kasir', '081277770001', '628127777001')
     on conflict (organization_id, phone_key) where phone_key is not null
     do update set name = excluded.name returning id`, [crypto.randomUUID(), orgId])
  bookingId = crypto.randomUUID()
  await pool.query(
    `insert into bookings (id, organization_id, team_id, staff_user_id, customer_id,
                           service_id, starts_at, ends_at, status,
                           duration_minutes, price, currency)
     values ($1, $2, $3, $4, $5, $6, $7::timestamp, $8::timestamp, 'pending',
             60, 150000, 'IDR')`,
    [bookingId, orgId, teamId, stylistId, customer.id, serviceId,
     `${DAY} 10:00`, `${DAY} 11:00`])
})

test.describe.serial('checkout', () => {
  test('rings up a booking, completes it, and prints a numbered receipt', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto(`/dashboard/pos?bookingId=${bookingId}`)
    // Prefilled from the booking -- Flow B's "open the 14:00 booking, checkout".
    await expect(page.getByTestId('cart-total')).toContainText('150.000')
    await page.getByRole('button', { name: 'Selesaikan pembayaran' }).click()

    await page.waitForURL('**/dashboard/transactions/**')
    await expect(page.getByText('INV-000001')).toBeVisible()
    await expect(page.getByText('Creambath')).toBeVisible()

    const rows = await sales()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ invoice_no: 1, status: 'completed', total: '150000' })

    const booking = await pool.query(`select status from bookings where id = $1`, [bookingId])
    expect(booking.rows[0].status, 'money is proof they showed up').toBe('completed')
  })

  test('refuses to charge the same booking twice', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto(`/dashboard/pos?bookingId=${bookingId}`)
    await page.getByRole('button', { name: 'Selesaikan pembayaran' }).click()
    await page.waitForURL('**/dashboard/transactions/**')

    await page.goto(`/dashboard/pos?bookingId=${bookingId}`)
    await page.getByRole('button', { name: 'Selesaikan pembayaran' }).click()
    await expect(page.getByText('Janji temu ini sudah dibayar.')).toBeVisible()
    expect(await sales()).toHaveLength(1)
  })

  test('rings up a direct sale with no booking and no customer', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto('/dashboard/pos')
    await page.locator('#add').selectOption(serviceId)
    await expect(page.getByTestId('cart-total')).toContainText('150.000')
    await page.getByRole('button', { name: 'Selesaikan pembayaran' }).click()
    await page.waitForURL('**/dashboard/transactions/**')

    const { rows } = await pool.query(
      `select customer_id, booking_id from transactions where organization_id = $1`, [orgId])
    expect(rows[0]).toEqual({ customer_id: null, booking_id: null })
  })

  test('numbers consecutive sales, and a void gets its own number', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto('/dashboard/pos')
    await page.locator('#add').selectOption(serviceId)
    await page.getByRole('button', { name: 'Selesaikan pembayaran' }).click()
    await page.waitForURL('**/dashboard/transactions/**')

    await page.goto(`/dashboard/transactions?date=${todayIso()}`)
    await page.getByRole('button', { name: 'Batalkan' }).click()
    await expect(page.getByText('Pembatalan')).toBeVisible()

    const rows = await sales()
    expect(rows.map((r) => r.invoice_no)).toEqual([1, 2])
    expect(Number(rows[0].total) + Number(rows[1].total), 'the ledger nets to zero').toBe(0)
  })
})

test.describe.serial('who may do what', () => {
  test('front desk may check out but is refused void, and never sees the button', async ({ page }) => {
    await page.context().addCookies(await deskCookies())
    await page.goto('/dashboard/pos')
    await page.locator('#add').selectOption(serviceId)
    await page.getByRole('button', { name: 'Selesaikan pembayaran' }).click()
    await page.waitForURL('**/dashboard/transactions/**')

    await page.goto(`/dashboard/transactions?date=${todayIso()}`)
    await expect(page.getByRole('button', { name: 'Batalkan' }),
      'pos:[void] is owner and admin only').toHaveCount(0)

    // ...and the endpoint itself refuses, not merely the markup. The Server
    // Action's own fields are harvested from the OWNER's page, since front
    // desk is never shown the form -- which is exactly the shape a real
    // escalation takes: a payload lifted from a privileged screen.
    const { rows } = await pool.query(
      `select id from transactions where organization_id = $1`, [orgId])
    const privileged = await (await owner.get(`/dashboard/transactions?date=${todayIso()}`)).text()
    const form = privileged.split('<form').find((f) => f.includes('Batalkan'))
    if (!form) throw new Error('the owner should see a void form')
    const multipart: Record<string, string> = { id: rows[0].id }
    for (const [, k, v] of form.slice(0, form.indexOf('</form>')).matchAll(
      /<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?\s*\/>/g)) {
      multipart[k] = (v ?? '').replace(/&quot;/g, '"')
    }
    const posted = await desk.post('/dashboard/transactions', { multipart, maxRedirects: 0 })
    // requirePagePermission redirects rather than throwing -- the page-guard
    // family's contract. What matters is that nothing was written.
    expect(posted.status()).toBe(303)
    const after = await pool.query(
      `select count(*)::int n from transactions where organization_id = $1`, [orgId])
    expect(after.rows[0].n, 'nothing was reversed').toBe(1)
  })
})

test.describe.serial('the shift window', () => {
  test('closing the shift takes away the ability to void', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto('/dashboard/pos')
    await page.locator('#add').selectOption(serviceId)
    await page.getByRole('button', { name: 'Selesaikan pembayaran' }).click()
    await page.waitForURL('**/dashboard/transactions/**')

    await page.goto(`/dashboard/transactions?date=${todayIso()}`)
    await expect(page.getByRole('button', { name: 'Batalkan' })).toBeVisible()
    await page.getByRole('button', { name: 'Tutup shift' }).click()

    await expect(page.getByRole('button', { name: 'Batalkan' }),
      'a closed shift locks its takings').toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Tutup shift' })).toHaveCount(0)
  })
})

test.describe.serial('branding', () => {
  test('an SVG is refused, and a PNG is accepted and served', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto('/dashboard/settings')

    await page.locator('#logo').setInputFiles({
      name: 'logo.svg',
      mimeType: 'image/png', // lying about the type on purpose
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    })
    await page.getByRole('button', { name: 'Simpan tampilan' }).click()
    await expect(page.getByText('Logo harus PNG, JPEG atau WebP.'),
      'the magic bytes decide, not the declared type').toBeVisible()

    await page.locator('#logo').setInputFiles({
      name: 'logo.png', mimeType: 'image/png', buffer: PNG,
    })
    await page.locator('#brandColor').fill('#1a2b3c')
    await page.getByRole('button', { name: 'Simpan tampilan' }).click()
    await expect(page.getByText('Tampilan disimpan.')).toBeVisible()

    const served = await page.request.get('/api/salon/logo?salon=poscheck')
    expect(served.status()).toBe(200)
    expect(served.headers()['content-type']).toBe('image/png')
  })

  test('refuses a brand colour that is not #rrggbb', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto('/dashboard/settings')
    await page.locator('#brandColor').fill('javascript:alert(1)')
    await page.getByRole('button', { name: 'Simpan tampilan' }).click()
    await expect(page.getByText('Warna harus format #rrggbb, misalnya #1a2b3c.')).toBeVisible()
  })

  test('the receipt and the public page both carry the logo', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto('/dashboard/pos')
    await page.locator('#add').selectOption(serviceId)
    await page.getByRole('button', { name: 'Selesaikan pembayaran' }).click()
    await page.waitForURL('**/dashboard/transactions/**')
    await expect(page.locator('img[src*="/api/salon/logo"]')).toBeVisible()

    await page.goto('http://poscheck.localhost:3100/book')
    await expect(page.locator('img[src*="/api/salon/logo"]')).toBeVisible()
  })
})

/** A 1x1 PNG -- real magic bytes, since that is what the upload checks. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function todayIso() {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
