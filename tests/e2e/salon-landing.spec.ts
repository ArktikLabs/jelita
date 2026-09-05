import { expect, test } from '@playwright/test'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from '../db'
import { createSalon, E2E_PORT } from './fixtures'

/**
 * The salon shopfront a tenant subdomain serves at its root.
 *
 * Driven on a REAL tenant hostname, like public-booking.spec.ts: a suite that
 * only used /salon/<slug> would pass with the host rewrite deleted, and the
 * rewrite is half of what this slice changed.
 */
const DOMAIN = 'landcheck.local'
const PW = 'demo12345'
const PORT = E2E_PORT
const SLUG = 'landcheck'
const OTHER = 'landcheck-two'
const at = (slug: string, path = '/') => `http://${slug}.localhost:${PORT}${path}`

const pool = new Pool({ connectionString: TEST_DATABASE_URL })

let orgId: string
let teamId: string
let otherTeamId: string
let closedTeamId: string
let serviceId: string

test.beforeAll(async () => {
  await pool.query(`delete from organizations where slug like 'landcheck%'`)
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`])

  const one = await createSalon(pool, {
    name: 'Land Owner', email: `owner@${DOMAIN}`, password: PW,
    salon: 'Salon Mekar', slug: SLUG,
  })
  orgId = one.organizationId
  const { rows: [team] } = await pool.query(
    `select id from teams where organization_id = $1 order by created_at limit 1`, [orgId])
  teamId = team.id
  await pool.query(
    `update teams set name = 'Cabang Pusat' where id = $1`, [teamId])
  await pool.query(
    `update branch_profiles set address = 'Jl. Melati No. 9, Bandung', phone = '022-5550101'
      where team_id = $1`, [teamId])

  serviceId = crypto.randomUUID()
  const catId = crypto.randomUUID()
  await pool.query(
    `insert into service_categories (id, organization_id, name) values ($1, $2, 'Perawatan')`,
    [catId, orgId])
  await pool.query(
    `insert into services (id, organization_id, category_id, name, duration_minutes, price)
     values ($1, $2, $3, 'Creambath Mekar', 60, 88000)`, [serviceId, orgId, catId])

  // A CLOSED branch, so "only active branches are on the shopfront" is
  // falsifiable. Without one, removing that filter fails nothing and the
  // guard is a claim no test can check.
  closedTeamId = crypto.randomUUID()
  await pool.query(
    `insert into teams (id, name, organization_id, created_at)
     values ($1, 'Cabang Tutup', $2, now())`, [closedTeamId, orgId])
  await pool.query(
    `update branch_profiles set active = false, address = 'Jl. Sudah Tutup No. 1'
      where team_id = $1`, [closedTeamId])

  const two = await createSalon(pool, {
    name: 'Land Owner Two', email: `owner2@${DOMAIN}`, password: PW,
    salon: 'Salon Kenanga', slug: OTHER,
  })
  const { rows: [team2] } = await pool.query(
    `select id from teams where organization_id = $1 order by created_at limit 1`,
    [two.organizationId])
  otherTeamId = team2.id
})

test.afterAll(async () => {
  await pool.query(`delete from organizations where slug like 'landcheck%'`)
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`])
  await pool.end()
})

test.describe('the salon shopfront', () => {
  test('the bare subdomain serves the shopfront, not the booking form', async ({ page }) => {
    await page.goto(at(SLUG))
    await expect(page.getByRole('heading', { name: 'Salon Mekar' })).toBeVisible()
    // The booking form's own controls must NOT be here -- that is the whole
    // change, and without this the test passes on the old rewrite.
    await expect(page.locator('input[name="startsAt"]')).toHaveCount(0)
    await expect(page.locator('#phone')).toHaveCount(0)
  })

  test('/book still serves the booking form', async ({ page }) => {
    await page.goto(at(SLUG, '/book'))
    await expect(page.locator('select').first()).toBeVisible()
  })

  test('shows the address, phone, hours and a price', async ({ page }) => {
    await page.goto(at(SLUG))
    const body = await page.locator('body').innerText()
    expect(body).toContain('Jl. Melati No. 9, Bandung')
    expect(body).toContain('022-5550101')
    expect(body).toContain('Senin')
    expect(body).toContain('Creambath Mekar')
    expect(body).toContain('88.000')
    expect(body).toContain('Perawatan')
  })

  test('a service row books that service, already chosen', async ({ page }) => {
    await page.goto(at(SLUG))
    await page.getByRole('link', { name: /Creambath Mekar/ }).click()
    await page.waitForURL(/\/book/)
    expect(new URL(page.url()).searchParams.get('serviceId')).toBe(serviceId)
    // ...and the form really is on that service, not merely carrying a param.
    await expect(page.locator('select').first()).toHaveValue(serviceId)
  })

  test('a different subdomain is a different salon', async ({ page }) => {
    await page.goto(at(OTHER))
    await expect(page.getByRole('heading', { name: 'Salon Kenanga' })).toBeVisible()
    expect(await page.content()).not.toContain('Salon Mekar')
  })

  test('refuses a branch belonging to another salon', async ({ page }) => {
    const res = await page.goto(at(SLUG, `/?cabang=${otherTeamId}`))
    expect(res?.status()).toBe(404)
  })

  test('an unknown salon is a 404, not a directory', async ({ page }) => {
    const res = await page.goto(at('tidak-ada-salon'))
    expect(res?.status()).toBe(404)
  })

  test('a closed branch is not on the shopfront', async ({ page }) => {
    await page.goto(at(SLUG))
    const body = await page.locator('body').innerText()
    expect(body).toContain('Cabang Pusat')
    expect(body, 'a closed branch must not be advertised').not.toContain('Cabang Tutup')
    expect(body).not.toContain('Jl. Sudah Tutup No. 1')
  })

  test('carries no staff names', async ({ page }) => {
    await page.goto(at(SLUG))
    // §4: the roster is not shopfront material. The owner's name is the one
    // staff name this fixture has.
    expect(await page.content()).not.toContain('Land Owner')
  })

  test('fits a phone with no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(at(SLUG))
    expect(await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
})
