import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from '../db'
import { createSalon } from './fixtures'

/**
 * The schedule card: the weekly form's round trip, exceptions and time-off
 * blocks, and which staff the card renders for.
 *
 * The resolution rule itself lives in tests/schedule.db.test.ts -- SQL
 * assertions cover precedence and intersection far better than driving a
 * form, and booking calls the function directly.
 */
const DOMAIN = 'schedcheck.local'
const PW = 'demo12345'

const pool = new Pool({ connectionString: TEST_DATABASE_URL })

let orgId: string
let stylistId: string
let adminId: string
let owner: Awaited<ReturnType<typeof createSalon>>['ctx']

/** The owner's session, in a shape page.context().addCookies accepts. */
const ownerCookies = async () => (await owner.storageState()).cookies

const hoursFor = async (userId: string, weekday: number) => (await pool.query(
  `select closed, opens_at::text, closes_at::text from staff_hours
    where user_id = $1 and organization_id = $2 and weekday = $3`,
  [userId, orgId, weekday])).rows[0]

/**
 * Drive the weekly form in a REAL browser.
 *
 * Not hand-built FormData: whether a field is submitted at all is exactly what
 * these tests are about, and only a browser decides that. Constructing the
 * payload by hand always sets the time fields, so it cannot tell readOnly from
 * disabled -- the very bug this file exists to catch. Verified: with the
 * hand-built version, switching the inputs to `disabled` failed nothing.
 */
async function openSchedule(page: Page, userId: string) {
  await page.goto(`/staff/${userId}`)
  // Wait on the control the test is about to use, not on a title: it is the
  // thing whose presence actually matters, and titles are not unique.
  await expect(page.locator('#sched-closed-1')).toBeVisible()
}

async function setMonday(
  page: Page, userId: string,
  { closed, opens, closes }: { closed?: boolean; opens?: string; closes?: string },
) {
  // Reload before each save rather than reusing the post-submit page: the
  // previous save's "Tersimpan." is still on screen, so waiting for it would
  // pass before this save had even started.
  await openSchedule(page, userId)
  const box = page.locator('#sched-closed-1')
  if (closed !== undefined && (await box.isChecked()) !== closed) {
    // Click the label, not the control: base-ui's Checkbox renders a button
    // the label sits over, so clicking the control directly can never land.
    await page.locator('label[for=\'sched-closed-1\']').click()
    await expect(box).toBeChecked({ checked: closed })
  }
  if (opens) await page.locator('input[name="opens-1"]').fill(opens)
  if (closes) await page.locator('input[name="closes-1"]').fill(closes)
  await page.getByRole('button', { name: 'Simpan jadwal' }).click()
  await expect(page.getByText('Tersimpan.')).toBeVisible()
}

test.beforeAll(async () => {
  await pool.query(`delete from organizations where slug like 'schedcheck%'`)
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`])

  const salon = await createSalon(pool, {
    name: 'Sched Owner', email: `owner@${DOMAIN}`, password: PW,
    salon: 'Sched Check', slug: 'schedcheck',
  })
  owner = salon.ctx
  orgId = salon.organizationId

  const { rows: [team] } = await pool.query(
    `select id from teams where organization_id = $1 order by created_at limit 1`, [orgId])

  const stylist = await owner.post('/api/staff', {
    data: {
      name: 'Sched Stylist', email: `stylist@${DOMAIN}`, password: PW,
      role: 'stylist', branchId: team.id,
    },
  })
  stylistId = (await stylist.json()).user.id

  const admin = await owner.post('/api/staff', {
    data: { name: 'Sched Admin', email: `admin@${DOMAIN}`, password: PW, role: 'admin' },
  })
  adminId = (await admin.json()).user.id
})

test.afterAll(async () => {
  await pool.query(`delete from organizations where slug like 'schedcheck%'`)
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`])
  await pool.end()
})

test.describe.serial('the schedule card', () => {
  test('a new hire already has a seven-day pattern', async () => {
    const { rows } = await pool.query(
      `select count(*)::int n from staff_hours where user_id = $1 and organization_id = $2`,
      [stylistId, orgId])
    // Seeded by trigger: an unconfigured schedule that silently means "never
    // bookable" is a failure nobody sees.
    expect(rows[0].n).toBe(7)
  })

  test('the weekly form saves and the page shows it back', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await setMonday(page, stylistId, { closed: false, opens: '10:00', closes: '18:00' })
    const monday = await hoursFor(stylistId, 1)
    expect(monday.opens_at).toBe('10:00:00')
    expect(monday.closes_at).toBe('18:00:00')
  })

  test('marking a day off does NOT wipe its hours', async ({ page }) => {
    // The time inputs are readOnly rather than disabled precisely so a browser
    // still submits them. A disabled input sends nothing, and the branch hours
    // form shipped that bug once: closing a day destroyed its stored hours, so
    // reopening it silently returned the defaults.
    await page.context().addCookies(await ownerCookies())
    await setMonday(page, stylistId, { closed: false, opens: '10:00', closes: '18:00' })

    await setMonday(page, stylistId, { closed: true })
    const closedMonday = await hoursFor(stylistId, 1)
    expect(closedMonday.closed).toBe(true)
    expect(closedMonday.opens_at, 'hours must survive being marked off').toBe('10:00:00')

    await setMonday(page, stylistId, { closed: false })
    const reopened = await hoursFor(stylistId, 1)
    expect(reopened.closed).toBe(false)
    expect(reopened.opens_at, 'and come back on reopening').toBe('10:00:00')
  })

  test('an exception is stored and listed', async () => {
    const page = await owner.get(`/staff/${stylistId}`)
    const html = await page.text()
    const anchor = html.indexOf('name="onDate"')
    const formHtml = html.slice(html.lastIndexOf('<form', anchor), html.indexOf('</form>', anchor))
    const body = new FormData()
    for (const m of formHtml.matchAll(
      /<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?\s*\/>/g)) {
      body.set(m[1].replace(/&quot;/g, '"'), (m[2] ?? '').replace(/&quot;/g, '"'))
    }
    body.set('userId', stylistId)
    body.set('onDate', '2099-01-05')
    body.set('closed', 'on')
    body.set('note', 'cuti')
    await owner.post(`/staff/${stylistId}`, { multipart: body as never })

    const { rows } = await pool.query(
      `select closed, note from staff_schedule_exceptions
        where user_id = $1 and on_date = '2099-01-05'::date`, [stylistId])
    expect(rows[0]?.closed).toBe(true)
    expect(rows[0]?.note).toBe('cuti')
    expect(await (await owner.get(`/staff/${stylistId}`)).text()).toContain('2099-01-05')
  })

  test('the cards are not offered for management, who cannot be scheduled', async () => {
    // Owners and admins carry team_id null, so staff_working_hours returns
    // nothing for them -- a schedule card there would edit a pattern that can
    // never produce a bookable hour (staff spec §8, carried forward).
    const html = await (await owner.get(`/staff/${adminId}`)).text()
    expect(html).not.toContain('Jadwal mingguan')
    expect(html).toContain('Peran')
  })
})
