import { expect, test } from '@playwright/test'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from '../db'
import { createSalon, E2E_PORT, signIn } from './fixtures'

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
    // phone_key is what normalizePhone(phone) actually produces -- written by
    // hand once and one digit short, which made the POS search find nothing
    // and looked like a broken search rather than a broken fixture.
    `insert into customers (id, organization_id, name, phone, phone_key)
     values ($1, $2, 'Ibu Kasir', '081277770001', '6281277770001')
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

test.describe.serial('commissions', () => {
  let stylistCtx: Awaited<ReturnType<typeof signIn>>

  test.beforeAll(async () => {
    stylistCtx = await signIn(`stylist@${DOMAIN}`, PW)
    await pool.query(
      `update salon_profiles set commission_kind = 'percent', commission_value = 1000
        where organization_id = $1`, [orgId])
  })

  test('a sale attributed to a stylist shows in that month\'s recap', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    // From the booking, so the stylist is defaulted -- making the desk re-pick
    // them is how commissions end up unattributed.
    await page.goto(`/dashboard/pos?bookingId=${bookingId}`)
    await page.getByRole('button', { name: 'Selesaikan pembayaran' }).click()
    await page.waitForURL('**/dashboard/transactions/**')

    await page.goto(`/dashboard/commissions?month=${monthOf(todayIso())}`)
    await expect(page.getByRole('cell', { name: 'Pos Stylist' })).toBeVisible()
    // 10% of 150.000
    await expect(page.getByRole('cell', { name: '15.000', exact: false })).toBeVisible()
  })

  test('a stylist sees only their own row; an owner sees the liability total', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto(`/dashboard/pos?bookingId=${bookingId}`)
    await page.getByRole('button', { name: 'Selesaikan pembayaran' }).click()
    await page.waitForURL('**/dashboard/transactions/**')

    const asOwner = await (await owner.get(`/dashboard/commissions?month=${monthOf(todayIso())}`)).text()
    expect(asOwner).toContain('Total komisi bulan ini')

    const asStylist = await (await stylistCtx.get(
      `/dashboard/commissions?month=${monthOf(todayIso())}`)).text()
    expect(asStylist, 'a stylist holds read:own, not read').toContain('Pendapatan saya')
    expect(asStylist, 'and must not be shown the salon-wide liability')
      .not.toContain('Total komisi bulan ini')
  })

  test('voiding takes the earnings back out of the recap', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto(`/dashboard/pos?bookingId=${bookingId}`)
    await page.getByRole('button', { name: 'Selesaikan pembayaran' }).click()
    await page.waitForURL('**/dashboard/transactions/**')

    await page.goto(`/dashboard/transactions?date=${todayIso()}`)
    await page.getByRole('button', { name: 'Batalkan' }).click()
    await expect(page.getByText('Pembatalan')).toBeVisible()

    const { rows } = await pool.query(
      `select coalesce(sum(amount), 0)::bigint total from commissions
        where organization_id = $1`, [orgId])
    expect(Number(rows[0].total), 'a void must not pay for a sale that did not happen').toBe(0)
  })
})

test.describe.serial('retail and stock', () => {
  let productId: string
  let stylistCtx: Awaited<ReturnType<typeof signIn>>

  test.beforeAll(async () => {
    stylistCtx = await signIn(`stylist@${DOMAIN}`, PW)
  })

  test.beforeEach(async () => {
    await pool.query(`delete from stock_movements where organization_id = $1`, [orgId])
    await pool.query(`delete from products where organization_id = $1`, [orgId])
    productId = crypto.randomUUID()
    await pool.query(
      `insert into products (id, organization_id, name, kind, price, reorder_level)
       values ($1, $2, 'Sampo Ritel', 'retail', 60000, 2)`, [productId, orgId])
    await pool.query(
      `insert into stock_movements (id, organization_id, team_id, product_id, quantity, reason)
       values ($1, $2, $3, $4, 10, 'purchase')`,
      [crypto.randomUUID(), orgId, teamId, productId])
  })

  test('sells a product beside a service, and the stock drops', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto('/dashboard/pos')
    await page.locator('#add').selectOption(serviceId)
    await page.locator('#add').selectOption(productId)
    // 150.000 + 60.000
    await expect(page.getByTestId('cart-total')).toContainText('210.000')
    await page.getByRole('button', { name: 'Selesaikan pembayaran' }).click()
    await page.waitForURL('**/dashboard/transactions/**')

    await page.goto('/dashboard/products')
    await expect(page.getByTestId(`stock-${productId}`)).toContainText('9')
  })

  test('voiding puts the product back on the shelf', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto('/dashboard/pos')
    await page.locator('#add').selectOption(productId)
    await page.getByRole('button', { name: 'Selesaikan pembayaran' }).click()
    await page.waitForURL('**/dashboard/transactions/**')

    await page.goto(`/dashboard/transactions?date=${todayIso()}`)
    await page.getByRole('button', { name: 'Batalkan' }).click()
    await expect(page.getByText('Pembatalan')).toBeVisible()

    await page.goto('/dashboard/products')
    await expect(page.getByTestId(`stock-${productId}`)).toContainText('10')
  })

  test('flags low stock at or below the reorder level', async ({ page }) => {
    await pool.query(
      `insert into stock_movements (id, organization_id, team_id, product_id, quantity, reason)
       values ($1, $2, $3, $4, -8, 'usage')`,
      [crypto.randomUUID(), orgId, teamId, productId])
    await page.context().addCookies(await ownerCookies())
    await page.goto('/dashboard/products')
    await expect(page.getByText('Stok menipis:')).toBeVisible()
    await expect(page.getByTestId(`stock-${productId}`)).toContainText('Menipis')
  })

  test('front desk may read stock but is never offered the adjust form', async () => {
    // Front desk, not a stylist: lib/permissions.ts grants product:['read']
    // and stock:['read'] to frontdesk and neither to stylist. Asserted after
    // writing this against a stylist and watching the page redirect.
    const html = await (await desk.get('/dashboard/products')).text()
    expect(html, 'front desk holds product:[read]').toContain('Sampo Ritel')
    expect(html, 'but not stock:[adjust]').not.toContain('Catat stok')
    expect(html, 'nor product:[create]').not.toContain('Tambah produk')

    const asStylist = await stylistCtx.get('/dashboard/products')
    expect(asStylist.headers()['location'] ?? '',
      'a stylist holds no product statement at all').toContain('/dashboard')
  })
})

test.describe.serial('the member profile', () => {
  test('the customer page shows spend, visits and what was bought', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto(`/dashboard/pos?bookingId=${bookingId}`)
    await page.getByRole('button', { name: 'Selesaikan pembayaran' }).click()
    await page.waitForURL('**/dashboard/transactions/**')

    const { rows } = await pool.query(
      `select customer_id from transactions where organization_id = $1`, [orgId])
    await page.goto(`/dashboard/customers/${rows[0].customer_id}`)
    // Scoped to the stat tile: the same figure also appears on the visit row
    // below, and an unscoped match is a strict-mode violation rather than an
    // assertion.
    // By test id: the same figure appears on the visit row below, so an
    // unscoped text match is a strict-mode violation rather than an assertion.
    await expect(page.getByTestId('stat-Total belanja')).toContainText('150.000')
    await expect(page.getByTestId('stat-Kunjungan')).toHaveText('1')
    await expect(page.getByRole('cell', { name: 'Creambath' })).toBeVisible()
  })

  test('the POS finds a customer by number and carries them into the sale', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto('/dashboard/pos?q=081277770001')
    await page.getByRole('link', { name: /Ibu Kasir/ }).click()
    await expect(page.locator('#phone')).toHaveValue('081277770001')

    await page.locator('#add').selectOption(serviceId)
    await page.getByRole('button', { name: 'Selesaikan pembayaran' }).click()
    await page.waitForURL('**/dashboard/transactions/**')

    const { rows } = await pool.query(
      `select c.name from transactions t join customers c on c.id = t.customer_id
        where t.organization_id = $1`, [orgId])
    expect(rows[0].name, 'the sale attached to the customer that was picked')
      .toBe('Ibu Kasir')
  })

  test('carries a customer who has NO phone, where the id is the only link', async ({ page }) => {
    // With a phone on file the id is redundant: checkoutAction falls back to
    // findOrCreateByPhone and lands on the same person either way, so dropping
    // it fails nothing. A walk-in recorded by name only is where it matters.
    const nameless = crypto.randomUUID()
    await pool.query(
      `insert into customers (id, organization_id, name) values ($1, $2, 'Bu Tanpa Nomor')`,
      [nameless, orgId])

    await page.context().addCookies(await ownerCookies())
    await page.goto(`/dashboard/pos?customer=${nameless}`)
    await page.locator('#add').selectOption(serviceId)
    await page.getByRole('button', { name: 'Selesaikan pembayaran' }).click()
    await page.waitForURL('**/dashboard/transactions/**')

    const { rows } = await pool.query(
      `select customer_id from transactions where organization_id = $1`, [orgId])
    expect(rows[0].customer_id).toBe(nameless)
  })

  test('a search that matches nothing says so rather than looking broken', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto('/dashboard/pos?q=tidakada')
    await expect(page.getByText('Tidak ada yang cocok.', { exact: false })).toBeVisible()
  })
})

test.describe.serial('member points', () => {
  test.beforeEach(async () => {
    await pool.query(`update salon_profiles set points_per_unit = null
                       where organization_id = $1`, [orgId])
  })

  test('are absent entirely until a rate is set, then appear', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto(`/dashboard/pos?bookingId=${bookingId}`)
    await page.getByRole('button', { name: 'Selesaikan pembayaran' }).click()
    await page.waitForURL('**/dashboard/transactions/**')
    // No scheme, so the receipt says nothing about points at all -- not zero.
    await expect(page.getByTestId('receipt-points')).toHaveCount(0)

    const { rows } = await pool.query(
      `select customer_id from transactions where organization_id = $1`, [orgId])
    await page.goto(`/dashboard/customers/${rows[0].customer_id}`)
    await expect(page.getByTestId('stat-Poin')).toHaveCount(0)

    await page.goto('/dashboard/settings')
    await page.locator('#pointsPerUnit').fill('10.000')
    await page.getByRole('button', { name: 'Simpan aturan poin' }).click()
    await expect(page.getByText('Aturan poin disimpan.')).toBeVisible()

    // The earlier sale earned nothing -- points are recorded at checkout, not
    // computed on read, so turning the scheme on is not retroactive.
    await page.goto(`/dashboard/customers/${rows[0].customer_id}`)
    await expect(page.getByTestId('stat-Poin')).toHaveText('0')
  })

  test('a sale earns them, the receipt shows them, and a void gives them back', async ({ page }) => {
    await pool.query(`update salon_profiles set points_per_unit = 10000
                       where organization_id = $1`, [orgId])
    await page.context().addCookies(await ownerCookies())
    await page.goto(`/dashboard/pos?bookingId=${bookingId}`)
    await page.getByRole('button', { name: 'Selesaikan pembayaran' }).click()
    await page.waitForURL('**/dashboard/transactions/**')
    // 150.000 at 10.000 per point.
    await expect(page.getByTestId('receipt-points')).toContainText('15')

    const { rows } = await pool.query(
      `select customer_id from transactions where organization_id = $1
        and reverses_id is null`, [orgId])
    await page.goto(`/dashboard/customers/${rows[0].customer_id}`)
    await expect(page.getByTestId('stat-Poin')).toHaveText('15')

    await page.goto(`/dashboard/transactions?date=${todayIso()}`)
    await page.getByRole('button', { name: 'Batalkan' }).click()
    await expect(page.getByText('Pembatalan')).toBeVisible()

    await page.goto(`/dashboard/customers/${rows[0].customer_id}`)
    await expect(page.getByTestId('stat-Poin'),
      'the void returns exactly what the sale gave').toHaveText('0')
  })

  test('refuses a rate of zero', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto('/dashboard/settings')
    await page.locator('#pointsPerUnit').fill('0')
    await page.getByRole('button', { name: 'Simpan aturan poin' }).click()
    await expect(page.getByText('Nilai per poin harus lebih dari nol.')).toBeVisible()
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

    await page.goto(`http://poscheck.localhost:${E2E_PORT}/book`)
    await expect(page.locator('img[src*="/api/salon/logo"]')).toBeVisible()
  })
})

/** A 1x1 PNG -- real magic bytes, since that is what the upload checks. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const monthOf = (iso: string) => `${iso.slice(0, 7)}-01`

function todayIso() {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
