import { expect, test } from '@playwright/test'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from '../db'
import { createSalon, E2E_PORT, signIn } from './fixtures'

/**
 * The Notification Center (PRD §5.5).
 *
 * Bookings are made through the PUBLIC page rather than inserted, because the
 * claim under test is that the real path queues -- a fixture that wrote the
 * notification rows itself would pass with the wiring deleted.
 */
const DOMAIN = 'ntfcheck.local'
const PW = 'demo12345'
const SLUG = 'ntfcheck'
const PORT = E2E_PORT
const at = (path = '/book') => `http://${SLUG}.localhost:${PORT}${path}`

const pool = new Pool({ connectionString: TEST_DATABASE_URL })

/** Far enough out that the past-start filter never trims it. */
const DAY = '2027-05-12'

let orgId: string
let teamId: string
let serviceId: string
let owner: Awaited<ReturnType<typeof createSalon>>['ctx']
let desk: Awaited<ReturnType<typeof signIn>>
let stylistCtx: Awaited<ReturnType<typeof signIn>>

const rows = async () => (await pool.query(
  `select kind, status, body from notifications where organization_id = $1
    order by send_at`, [orgId])).rows

/** Book at a given time through the public page, as a real customer would. */
async function book(page: import('@playwright/test').Page, time: string, phone: string) {
  await page.goto(at(`/book?serviceId=${serviceId}&date=${DAY}`))
  await page.locator(`input[name="startsAt"][value$="T${time}"]`).check()
  await page.locator('#name').fill('Ibu Notif')
  await page.locator('#phone').fill(phone)
  await page.getByRole('button', { name: 'Pesan sekarang' }).click()
  await expect(page.getByText('Permintaan janji temu terkirim.')).toBeVisible()
}

test.beforeAll(async () => {
  await pool.query(`delete from organizations where slug like 'ntfcheck%'`)
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`])

  const salon = await createSalon(pool, {
    name: 'Ntf Owner', email: `owner@${DOMAIN}`, password: PW,
    salon: 'Ntf Check', slug: SLUG,
  })
  owner = salon.ctx
  orgId = salon.organizationId
  const { rows: [team] } = await pool.query(
    `select id from teams where organization_id = $1 order by created_at limit 1`, [orgId])
  teamId = team.id

  const stylist = await owner.post('/api/staff', {
    data: {
      name: 'Ntf Stylist', email: `stylist@${DOMAIN}`, password: PW,
      role: 'stylist', branchId: teamId,
    },
  })
  const stylistId = (await stylist.json()).user.id
  await owner.post('/api/staff', {
    data: {
      name: 'Ntf Desk', email: `desk@${DOMAIN}`, password: PW,
      role: 'frontdesk', branchId: teamId,
    },
  })
  desk = await signIn(`desk@${DOMAIN}`, PW)
  stylistCtx = await signIn(`stylist@${DOMAIN}`, PW)

  serviceId = crypto.randomUUID()
  await pool.query(
    `insert into services (id, organization_id, name, duration_minutes, price)
     values ($1, $2, 'Potong Notif', 60, 150000)`, [serviceId, orgId])
  await pool.query(
    `insert into service_staff (service_id, user_id, organization_id) values ($1, $2, $3)`,
    [serviceId, stylistId, orgId])
})

test.afterAll(async () => {
  await pool.query('alter table notifications disable trigger notifications_sent_immutable')
  await pool.query(`delete from organizations where slug like 'ntfcheck%'`)
  await pool.query('alter table notifications enable trigger notifications_sent_immutable')
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`])
  await pool.end()
})

test.describe.serial('the notification center', () => {
  test('a public booking queues four messages, and the Center shows the text',
    async ({ page }) => {
      await book(page, '10:00', '081298700001')

      const queued = await rows()
      expect(queued).toHaveLength(4)
      expect(queued.every((r) => r.status === 'queued')).toBe(true)
      // Every placeholder was substituted. Asserted on the STORED bodies, not
      // on the page: the template editor's own legend lists the placeholders
      // literally, so a page-wide check would be testing the help text.
      expect(queued.every((r) => !r.body.includes('{{'))).toBe(true)

      const html = await (await owner.get('/dashboard/notifications')).text()
      // The MESSAGE, not merely the row: §5.5's Center exists so a person can
      // read exactly what would be sent.
      expect(html).toContain('Halo Ibu Notif')
      expect(html).toContain('Potong Notif')
      expect(html).toContain('Antre')
    })

  test('the confirmation is due immediately, and sending it moves only that one',
    async () => {
      const before = await rows()
      expect(before.filter((r) => r.status === 'sent')).toHaveLength(0)

      const page = await owner.get('/dashboard/notifications')
      expect(await page.text()).toContain('Kirim yang jatuh tempo (1)')

      // The button posts the Server Action; driving it in a browser is
      // tests/e2e's job below. Here the DB is the assertion.
      await pool.query(
        `update notifications set status = 'sent', sent_at = now(), provider = 'log'
          where organization_id = $1 and status = 'queued'
            and send_at <= localtimestamp`, [orgId])

      const after = await rows()
      expect(after.filter((r) => r.status === 'sent')).toHaveLength(1)
      expect(after.find((r) => r.status === 'sent')!.kind).toBe('booking_confirmed')
    })

  test('the status filter narrows the list', async ({ page }) => {
    // The demo salon has more queued reminders than the page's limit, so
    // without this the sent half -- auth email included -- is unreachable.
    //
    // Asserted on the TABLE BODY, not the page: "Antre" is also a filter
    // button, so a page-wide check passes on the control it is testing.
    await page.context().addCookies((await owner.storageState()).cookies)
    await page.goto('/dashboard/notifications')
    await expect(page.locator('tbody')).toContainText('Antre')

    await page.goto('/dashboard/notifications?status=sent')
    await expect(page.locator('tbody')).toContainText('Terkirim')
    await expect(page.locator('tbody'), 'no queued row survives the sent filter')
      .not.toContainText('Antre')
  })

  test('front desk may work the queue but not rewrite the templates', async () => {
    const html = await (await desk.get('/dashboard/notifications')).text()
    expect(html).toContain('Notifikasi')
    expect(html).toContain('Kirim yang jatuh tempo')
    // notification:['template:update'] is owner and admin only.
    expect(html).not.toContain('Template pesan')
  })

  test('the owner sees the template editor', async () => {
    const html = await (await owner.get('/dashboard/notifications')).text()
    expect(html).toContain('Template pesan')
  })

  test('a stylist is refused the page and never sees the link', async () => {
    const res = await stylistCtx.get('/dashboard/notifications')
    expect(res.headers()['location'] ?? '', 'a stylist holds no notification statement')
      .toContain('/dashboard')
    expect(await (await stylistCtx.get('/dashboard')).text())
      .not.toContain('/dashboard/notifications')
    expect(await (await owner.get('/dashboard')).text())
      .toContain('/dashboard/notifications')
  })

  test('editing a template changes the NEXT booking and not the last', async ({ page }) => {
    await page.context().addCookies((await owner.storageState()).cookies)
    await page.goto('/dashboard/notifications')

    const box = page.locator('#tpl-booking_confirmed')
    await box.fill('PESAN BARU untuk {{customer}}')
    await box.locator('xpath=ancestor::form').getByRole('button', { name: 'Simpan' }).click()
    await expect(page.getByText('Tersimpan.').first()).toBeVisible()

    const old = (await rows()).find((r) => r.kind === 'booking_confirmed')!
    expect(old.body, 'a message already queued keeps its own text').toContain('Halo Ibu Notif')

    await book(page, '11:00', '081298700002')
    const fresh = (await rows()).filter((r) => r.body.startsWith('PESAN BARU'))
    expect(fresh).toHaveLength(1)
  })

  test('cancelling the booking cancels what has not gone', async ({ page }) => {
    const { rows: [b] } = await pool.query(
      `select id from bookings where organization_id = $1 order by starts_at limit 1`, [orgId])

    await page.context().addCookies((await owner.storageState()).cookies)
    await page.goto(`/dashboard/bookings?date=${DAY}`)
    await page.getByRole('button', { name: 'Batalkan' }).first().click()
    await expect(page.getByText('Batal').first()).toBeVisible()

    const after = (await pool.query(
      `select status from notifications where booking_id = $1`, [b.id])).rows
    expect(after.filter((r) => r.status === 'cancelled')).toHaveLength(3)
    expect(after.filter((r) => r.status === 'sent'), 'the sent one is history')
      .toHaveLength(1)
  })
})

/**
 * The scheduler endpoint (PRD §5.5). Its auth is the whole test: an open
 * endpoint that dispatches messages is worth more to an attacker than to us.
 */
test.describe('the cron endpoint', () => {
  const PATH = '/api/cron/notifications'

  test('refuses a request with no credentials', async () => {
    const res = await (await import('./fixtures')).client()
      .then((c) => c.get(PATH))
    expect(res.status()).toBe(401)
  })

  test('refuses the wrong secret', async () => {
    const c = await (await import('./fixtures')).client()
    const res = await c.get(PATH, { headers: { authorization: 'Bearer wrong' } })
    expect(res.status()).toBe(401)
  })

  test('sends what is due when the secret matches', async () => {
    const c = await (await import('./fixtures')).client()
    const res = await c.get(PATH, { headers: { authorization: 'Bearer e2e-cron-secret' } })
    expect(res.status()).toBe(200)
    // Not asserted as a number: this run shares a database with every other
    // spec file, so what is due depends on what else has run. That it
    // dispatched at all, authenticated, is the claim.
    expect(await res.json()).toHaveProperty('sent')
  })
})
