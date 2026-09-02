import { expect, test } from '@playwright/test'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from '../db'
import { createSalon } from './fixtures'

/**
 * The public booking page, driven on a REAL tenant hostname.
 *
 * `<slug>.localhost` resolves in Chrome without a hosts-file entry, so these
 * exercise the host rewrite in next.config.ts rather than the /book/<slug>
 * path it also answers on -- a suite that only used the path would pass with
 * the rewrite deleted.
 */
const DOMAIN = 'pubcheck.local'
const PW = 'demo12345'
const PORT = 3100

const pool = new Pool({ connectionString: TEST_DATABASE_URL })

const SLUG = 'pubcheck'
const OTHER_SLUG = 'pubcheck-two'
const at = (slug: string, path = '/book') => `http://${slug}.localhost:${PORT}${path}`

let orgId: string
let otherOrgId: string
let teamId: string
let otherTeamId: string
let serviceId: string
let stylistId: string
let owner: Awaited<ReturnType<typeof createSalon>>['ctx']

/** A Wednesday far enough out that the past-start filter never trims it. */
const DAY = '2027-05-12'

const bookings = async (organizationId = orgId) => (await pool.query(
  `select b.status, to_char(b.starts_at, 'HH24:MI') t, b.team_id, c.name, c.phone_key
     from bookings b join customers c on c.id = b.customer_id
    where b.organization_id = $1 order by b.starts_at`, [organizationId])).rows

async function seedSalon(slug: string, email: string, name: string) {
  const salon = await createSalon(pool, {
    name: `${name} Owner`, email, password: PW, salon: name, slug,
  })
  const { rows: [team] } = await pool.query(
    `select id from teams where organization_id = $1 order by created_at limit 1`,
    [salon.organizationId])
  return { ...salon, teamId: team.id as string }
}

test.beforeAll(async () => {
  await pool.query(`delete from organizations where slug like 'pubcheck%'`)
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`])

  const one = await seedSalon(SLUG, `owner@${DOMAIN}`, 'Pub Check')
  owner = one.ctx
  orgId = one.organizationId
  teamId = one.teamId

  const two = await seedSalon(OTHER_SLUG, `owner2@${DOMAIN}`, 'Pub Check Two')
  otherOrgId = two.organizationId
  otherTeamId = two.teamId

  const made = await owner.post('/api/staff', {
    data: {
      name: 'Pub Stylist', email: `stylist@${DOMAIN}`, password: PW,
      role: 'stylist', branchId: teamId,
    },
  })
  stylistId = (await made.json()).user.id

  serviceId = crypto.randomUUID()
  await pool.query(
    `insert into services (id, organization_id, name, duration_minutes, price)
     values ($1, $2, 'Potong Publik', 60, 150000)`, [serviceId, orgId])
  await pool.query(
    `insert into service_staff (service_id, user_id, organization_id) values ($1, $2, $3)`,
    [serviceId, stylistId, orgId])

  // The other salon sells something with a distinct name, so "this subdomain
  // shows THIS salon" is asserted on content, not merely on a 200.
  await pool.query(
    `insert into services (id, organization_id, name, duration_minutes, price)
     values ($1, $2, 'Layanan Salon Lain', 60, 200000)`, [crypto.randomUUID(), otherOrgId])
})

test.afterAll(async () => {
  await pool.query(`delete from organizations where slug like 'pubcheck%'`)
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`])
  await pool.end()
})

test.beforeEach(async () => {
  await pool.query(`delete from bookings where organization_id = any($1)`, [[orgId, otherOrgId]])
  await pool.query(`delete from customers where organization_id = any($1)`, [[orgId, otherOrgId]])
})

test.describe.serial('the public booking page', () => {
  test('a tenant subdomain serves that salon, and a different one serves a different salon', async ({ page }) => {
    await page.goto(at(SLUG))
    await expect(page.getByRole('heading', { name: 'Pub Check' })).toBeVisible()
    await expect(page.locator('#serviceId')).toContainText('Potong Publik')
    await expect(page.locator('#serviceId')).not.toContainText('Layanan Salon Lain')

    await page.goto(at(OTHER_SLUG))
    await expect(page.getByRole('heading', { name: 'Pub Check Two' })).toBeVisible()
    await expect(page.locator('#serviceId')).toContainText('Layanan Salon Lain')
    await expect(page.locator('#serviceId')).not.toContainText('Potong Publik')
  })

  test('the bare subdomain is the booking page too', async ({ page }) => {
    await page.goto(`http://${SLUG}.localhost:${PORT}/`)
    await expect(page.getByRole('heading', { name: 'Pub Check' })).toBeVisible()
  })

  test('an unknown subdomain 404s rather than saying which salons exist', async ({ page }) => {
    const res = await page.goto(at('tidak-ada-salon'))
    expect(res?.status()).toBe(404)
    expect(await page.content()).not.toContain('Pub Check')
  })

  test('books a slot with no account at all, landing pending', async ({ page }) => {
    await page.goto(at(SLUG, `/book?serviceId=${serviceId}&date=${DAY}`))
    await page.locator('input[name="startsAt"][value$="T10:00"]').check()
    await page.locator('#name').fill('Ibu Publik')
    await page.locator('#phone').fill('0812-3456-789')
    await page.getByRole('button', { name: 'Pesan sekarang' }).click()
    await expect(page.getByText('Permintaan janji temu terkirim.')).toBeVisible()

    const [row] = await bookings()
    expect(row).toMatchObject({ status: 'pending', t: '10:00', team_id: teamId })
    // Stored through the shared lookup, so the number is normalised and the
    // salon finds them by phone.
    expect(row.phone_key).toBe('628123456789')

    // ...and no session was created along the way.
    expect((await page.context().cookies()).filter((c) => c.name.includes('session')))
      .toHaveLength(0)
  })

  test('the booked slot stops being offered, and shows on the salon\'s own day', async ({ page }) => {
    await page.goto(at(SLUG, `/book?serviceId=${serviceId}&date=${DAY}`))
    await page.locator('input[name="startsAt"][value$="T10:00"]').check()
    await page.locator('#name').fill('Ibu Publik')
    await page.locator('#phone').fill('081234567890')
    await page.getByRole('button', { name: 'Pesan sekarang' }).click()
    await expect(page.getByText('Permintaan janji temu terkirim.')).toBeVisible()

    await page.goto(at(SLUG, `/book?serviceId=${serviceId}&date=${DAY}`))
    await expect(page.locator('input[name="startsAt"][value$="T10:00"]')).toHaveCount(0)

    const dashboard = await owner.get(`/dashboard/bookings?date=${DAY}`)
    expect(await dashboard.text()).toContain('Ibu Publik')
  })

  test('a slot taken between load and submit is refused, not double-booked', async ({ page }) => {
    await page.goto(at(SLUG, `/book?serviceId=${serviceId}&date=${DAY}`))
    await page.locator('input[name="startsAt"][value$="T11:00"]').check()
    await page.locator('#name').fill('Ibu Telat')
    await page.locator('#phone').fill('081234567891')
    await pool.query(
      `insert into customers (id, organization_id, name, phone_key)
       values ('pub_squatter_c', $1, 'Duluan', '628999999999')`, [orgId])
    await pool.query(
      `insert into bookings (id, organization_id, team_id, staff_user_id, customer_id,
                             service_id, starts_at, ends_at, status,
                             duration_minutes, price, currency)
       values ('pub_squatter', $1, $2, $3, 'pub_squatter_c', $4,
               $5::timestamp, $6::timestamp, 'pending', 60, 150000, 'IDR')`,
      [orgId, teamId, stylistId, serviceId, `${DAY} 11:00`, `${DAY} 12:00`])

    await page.getByRole('button', { name: 'Pesan sekarang' }).click()
    await expect(page.getByText('Jam itu baru saja diambil. Silakan pilih jam lain.')).toBeVisible()
    expect(await bookings(), 'nothing was written by the refused attempt').toHaveLength(1)
  })

  test('the per-phone daily cap refuses the sixth and writes nothing', async ({ page }) => {
    const times = ['09:00', '10:00', '11:00', '12:00', '13:00']
    for (const t of times) {
      await page.goto(at(SLUG, `/book?serviceId=${serviceId}&date=${DAY}`))
      await page.locator(`input[name="startsAt"][value$="T${t}"]`).check()
      await page.locator('#name').fill('Ibu Banyak')
      await page.locator('#phone').fill('081200000001')
      await page.getByRole('button', { name: 'Pesan sekarang' }).click()
      await expect(page.getByText('Permintaan janji temu terkirim.')).toBeVisible()
    }
    expect(await bookings()).toHaveLength(5)

    await page.goto(at(SLUG, `/book?serviceId=${serviceId}&date=${DAY}`))
    await page.locator('input[name="startsAt"][value$="T14:00"]').check()
    await page.locator('#name').fill('Ibu Banyak')
    // Respelled -- the cap counts the NORMALISED key, so this is the same
    // number and must not buy a fresh allowance.
    await page.locator('#phone').fill('+62 812 0000 0001')
    await page.getByRole('button', { name: 'Pesan sekarang' }).click()
    await expect(page.getByText('Nomor ini sudah punya banyak janji temu hari itu. Hubungi salon langsung.'))
      .toBeVisible()
    expect(await bookings()).toHaveLength(5)
  })

  test('a branch belonging to another salon is refused, not booked', async ({ page }) => {
    await page.goto(at(SLUG, `/book?serviceId=${serviceId}&date=${DAY}`))
    await page.locator('input[name="startsAt"][value$="T15:00"]').check()
    await page.locator('#name').fill('Ibu Silang')
    await page.locator('#phone').fill('081234567892')
    await page.evaluate((foreign) => {
      const el = document.querySelector('input[name="teamId"]') as HTMLInputElement
      el.value = foreign
    }, otherTeamId)

    await page.getByRole('button', { name: 'Pesan sekarang' }).click()
    await expect(page.getByText('Salon ini sedang tidak menerima pemesanan online.')).toBeVisible()
    expect(await bookings()).toHaveLength(0)
    expect(await bookings(otherOrgId), 'and nothing landed at the other salon either')
      .toHaveLength(0)
  })

  test('a salon whose every branch is closed says so, and offers nothing', async ({ page }) => {
    await pool.query(`update branch_profiles set active = false where team_id = $1`, [teamId])
    await page.goto(at(SLUG))
    await expect(page.getByText('Salon ini sedang tidak menerima pemesanan online.')).toBeVisible()
    await expect(page.locator('#serviceId')).toHaveCount(0)
    await pool.query(`update branch_profiles set active = true where team_id = $1`, [teamId])
  })
})
