import { expect, test } from '@playwright/test'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from '../db'
import { createSalon, signIn } from './fixtures'

/**
 * PRD §5.6's dashboard, and spec §2.1's scoping.
 *
 * TWO stylists with sales, deliberately: with one, "scoped to this stylist"
 * and "the whole branch" are the same number, and every scoping assertion
 * passes for free.
 */
const DOMAIN = 'repcheck.local'
const PW = 'demo12345'

const pool = new Pool({ connectionString: TEST_DATABASE_URL })

let orgId: string
let teamId: string
let cutId: string
let spaId: string
let sintaId: string
let rinaId: string
let customerId: string
let owner: Awaited<ReturnType<typeof createSalon>>['ctx']
let sinta: Awaited<ReturnType<typeof signIn>>

const ownerCookies = async () => (await owner.storageState()).cookies
const sintaCookies = async () => (await sinta.storageState()).cookies

const iso = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const TODAY = iso(new Date())

test.beforeAll(async () => {
  await pool.query(`delete from organizations where slug like 'repcheck%'`)
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`])

  const salon = await createSalon(pool, {
    name: 'Rep Owner', email: `owner@${DOMAIN}`, password: PW,
    salon: 'Rep Check', slug: 'repcheck',
  })
  owner = salon.ctx
  orgId = salon.organizationId
  const { rows: [team] } = await pool.query(
    `select id from teams where organization_id = $1 order by created_at limit 1`, [orgId])
  teamId = team.id
  await pool.query(`
    update subscriptions set plan_id = (select id from plans where key = 'business')
     where organization_id = $1`, [orgId])

  for (const [name, key] of [['Rep Sinta', 'sinta'], ['Rep Rina', 'rina']] as const) {
    const made = await owner.post('/api/staff', {
      data: { name, email: `${key}@${DOMAIN}`, password: PW, role: 'stylist', branchId: teamId },
    })
    const id = (await made.json()).user.id
    if (key === 'sinta') sintaId = id
    else rinaId = id
  }
  sinta = await signIn(`sinta@${DOMAIN}`, PW)

  cutId = crypto.randomUUID()
  spaId = crypto.randomUUID()
  await pool.query(`
    insert into services (id, organization_id, name, duration_minutes, price)
    values ($1, $2, 'Potong Rambut', 60, 100000), ($3, $2, 'Hair Spa', 60, 300000)`,
    [cutId, orgId, spaId])
  for (const service of [cutId, spaId]) {
    for (const staff of [sintaId, rinaId]) {
      await pool.query(
        `insert into service_staff (service_id, user_id, organization_id) values ($1, $2, $3)`,
        [service, staff, orgId])
    }
  }
  customerId = crypto.randomUUID()
  await pool.query(
    `insert into customers (id, organization_id, name) values ($1, $2, 'Pelanggan Rep')`,
    [customerId, orgId])
  await pool.query(
    `update salon_profiles set commission_kind = 'percent', commission_value = 1000
      where organization_id = $1`, [orgId])

  // Sinta: one Potong (100.000). Rina: one Hair Spa (300.000).
  // Branch revenue 400.000; Sinta's own 100.000 -- and they must differ.
  const { checkout } = await import('../../lib/pos')
  await checkout({
    organizationId: orgId, teamId, userId: sintaId, method: 'cash',
    items: [{ serviceId: cutId, quantity: 1, discount: 0, staffUserId: sintaId }],
    customerId, completedAt: `${TODAY} 10:00`,
  })
  await checkout({
    organizationId: orgId, teamId, userId: rinaId, method: 'cash',
    items: [{ serviceId: spaId, quantity: 1, discount: 0, staffUserId: rinaId }],
    customerId, completedAt: `${TODAY} 11:00`,
  })

  for (const [staff, status] of [
    [sintaId, 'completed'], [rinaId, 'completed'], [sintaId, 'no_show'],
    [rinaId, 'cancelled'],
  ] as const) {
    await pool.query(
      `insert into bookings (id, organization_id, team_id, staff_user_id, customer_id,
                             service_id, starts_at, ends_at, status,
                             duration_minutes, price, currency)
       values ($1, $2, $3, $4, $5, $6, $7::timestamp,
               $7::timestamp + interval '1 hour', $8, 60, 100000, 'IDR')`,
      [crypto.randomUUID(), orgId, teamId, staff, customerId, cutId,
       `${TODAY} ${staff === sintaId && status === 'completed' ? '14' : '15'}:00`, status])
  }
})

test.afterAll(async () => {
  await pool.query(`truncate transaction_payments, transaction_lines, transactions cascade`)
  await pool.query(`delete from organizations where slug like 'repcheck%'`)
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`])
  await pool.end()
})

test.describe('the owner dashboard', () => {
  test('shows revenue, the funnel, both top-service charts and staff performance', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto(`/dashboard?from=${TODAY}&to=${TODAY}`)

    await expect(page.getByTestId('kpi-Omzet')).toContainText('400.000')
    await expect(page.getByTestId('kpi-Janji temu')).toHaveText('4')
    // Two of four completed, one no-show -- cancellations stay in the
    // denominator, so 50% and 25%.
    await expect(page.getByTestId('kpi-Selesai')).toHaveText('50%')
    await expect(page.getByTestId('kpi-Tidak datang')).toHaveText('25%')

    await expect(page.getByText('Layanan teratas — omzet')).toBeVisible()
    await expect(page.getByText('Layanan teratas — jumlah')).toBeVisible()
    // Direct value labels mean the figures survive without reading the marks.
    await expect(page.getByText('Kinerja staf')).toBeVisible()
    await expect(page.getByRole('cell', { name: 'Rep Sinta' })).toBeVisible()
    await expect(page.getByRole('cell', { name: 'Rep Rina' })).toBeVisible()
  })

  test('the trend renders a chart, not an empty box', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto(`/dashboard?from=${TODAY}&to=${TODAY}`)
    // Recharts draws an SVG; an empty container would have none.
    await expect(page.locator('.recharts-surface').first()).toBeVisible()
  })
})

test.describe('the stylist dashboard', () => {
  test('shows the same sections scoped to themselves, and not the branch', async ({ page }) => {
    await page.context().addCookies(await sintaCookies())
    await page.goto(`/dashboard?from=${TODAY}&to=${TODAY}`)

    await expect(page.getByRole('heading', { name: 'Ringkasan saya' })).toBeVisible()
    // 100.000, not the branch's 400.000 -- which is why the fixture has two
    // stylists with different sales.
    await expect(page.getByTestId('kpi-Omzet saya')).toContainText('100.000')
    await expect(page.getByTestId('kpi-Omzet saya')).not.toContainText('400.000')
    // Her two bookings: one completed, one no-show.
    await expect(page.getByTestId('kpi-Janji temu')).toHaveText('2')
    await expect(page.getByTestId('kpi-Tidak datang')).toHaveText('50%')
    await expect(page.getByTestId('kpi-Komisi')).toContainText('10.000')
  })

  test('never sees salon-wide figures, staff performance or stock', async ({ page }) => {
    await page.context().addCookies(await sintaCookies())
    await page.goto(`/dashboard?from=${TODAY}&to=${TODAY}`)
    await expect(page.getByText('Kinerja staf')).toHaveCount(0)
    await expect(page.getByText('Stok menipis')).toHaveCount(0)
    await expect(page.getByTestId('kpi-Omzet'), 'the salon-wide tile').toHaveCount(0)
    // ...and their colleague's work is nowhere on the page.
    await expect(page.getByText('Rep Rina')).toHaveCount(0)
  })

  test('sees only their own service in the top-service charts', async ({ page }) => {
    await page.context().addCookies(await sintaCookies())
    await page.goto(`/dashboard?from=${TODAY}&to=${TODAY}`)
    await expect(page.getByText('Potong Rambut').first()).toBeVisible()
    await expect(page.getByText('Hair Spa'), "the colleague's service").toHaveCount(0)
  })
})

test.describe('the range', () => {
  test('a range with no sales shows zero rather than NaN', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto('/dashboard?from=2020-01-01&to=2020-01-07')
    await expect(page.getByTestId('kpi-Selesai')).toHaveText('0%')
    await expect(page.getByTestId('kpi-Tidak datang')).toHaveText('0%')
    await expect(page.getByTestId('kpi-Omzet')).toContainText('0')
  })
})
