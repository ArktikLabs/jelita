// tests/e2e/shell.spec.ts
import { test, expect } from '@playwright/test'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from '../db'
import { createSalon, signIn } from './fixtures'

/**
 * The shell as three people meet it: the owner picks a look on Pengaturan,
 * a stylist in the same salon sees it on their next load, and on a phone
 * the navigation is a drawer that lists only what that role may open.
 */
const pool = new Pool({ connectionString: TEST_DATABASE_URL })
const DOMAIN = 'shellcheck.test'
const PW = 'ShellCheck#2026'

let orgId: string
let owner: Awaited<ReturnType<typeof createSalon>>['ctx']
let stylist: Awaited<ReturnType<typeof signIn>>

const cookiesOf = async (ctx: typeof owner) => (await ctx.storageState()).cookies

test.beforeAll(async () => {
  await pool.query(`delete from organizations where slug = 'shellcheck'`)
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`])
  const salon = await createSalon(pool, {
    name: 'Shell Owner', email: `owner@${DOMAIN}`, password: PW,
    salon: 'Shell Check', slug: 'shellcheck',
  })
  owner = salon.ctx
  orgId = salon.organizationId
  const { rows: [team] } = await pool.query(
    `select id from teams where organization_id = $1 order by created_at limit 1`, [orgId])
  await owner.post('/api/staff', {
    data: { name: 'Shell Stylist', email: `stylist@${DOMAIN}`, password: PW, role: 'stylist', branchId: team.id },
  })
  stylist = await signIn(`stylist@${DOMAIN}`, PW)
})

test.afterAll(async () => {
  await pool.query(`delete from organizations where id = $1`, [orgId])
  await pool.end()
})

test('a fresh salon is ivory: light, no accent override', async ({ page }) => {
  await page.context().addCookies(await cookiesOf(owner))
  await page.goto('/dashboard')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(page.locator('[data-sidebar="sidebar"]')).toBeVisible()
  await expect(page.locator('[data-sidebar="sidebar"]').getByRole('link', { name: 'Kasir' })).toBeVisible()
})

test('the owner picks Charcoal and an accent; a stylist sees both on next load', async ({ page, browser }) => {
  await page.context().addCookies(await cookiesOf(owner))
  await page.goto('/dashboard/settings')
  await page.getByRole('radio', { name: 'Charcoal' }).check({ force: true })
  await page.locator('#brandColor').fill('#7aa2f7')
  await page.getByRole('button', { name: 'Simpan tampilan' }).click()
  await expect(page.getByText('Tampilan disimpan.')).toBeVisible()
  // Applied without a reload: the applier effect ran on the re-rendered layout.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

  const { rows } = await pool.query(
    `select theme, brand_color from salon_profiles where organization_id = $1`, [orgId])
  expect(rows[0]).toEqual({ theme: 'charcoal', brand_color: '#7aa2f7' })

  const ctx = await browser.newContext()
  await ctx.addCookies(await cookiesOf(stylist))
  const other = await ctx.newPage()
  await other.goto('/dashboard')
  await expect(other.locator('html')).toHaveAttribute('data-theme', 'dark')
  const primary = await other.evaluate(
    () => getComputedStyle(document.documentElement).getPropertyValue('--primary').trim())
  expect(primary).toBe('#7aa2f7')
  await ctx.close()
})

test('on a phone the stylist opens the drawer and sees only their four links', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
  await ctx.addCookies(await cookiesOf(stylist))
  const page = await ctx.newPage()
  await page.goto('/dashboard')
  await expect(page.locator('[data-sidebar="sidebar"]')).toBeHidden()
  await page.locator('[data-sidebar="trigger"]').click()
  const drawer = page.locator('[data-sidebar="sidebar"]')
  await expect(drawer).toBeVisible()
  const links = drawer.getByRole('link').filter({ hasNotText: 'Shell Check' })
  await expect(links).toHaveText(['Dasbor', 'Janji temu', 'Pelanggan', 'Komisi'])
  await expect(drawer.getByText('Katalog')).toHaveCount(0)
  await links.filter({ hasText: 'Komisi' }).click()
  await expect(page).toHaveURL(/\/dashboard\/commissions/)
  await expect(drawer).toBeHidden()
  await ctx.close()
})

test('on a phone the owner can open the branch switcher inside the drawer', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
  await ctx.addCookies(await cookiesOf(owner))
  const page = await ctx.newPage()
  await page.goto('/dashboard')
  await page.locator('[data-sidebar="trigger"]').click()
  await page.getByRole('button', { name: /Ganti cabang/ }).click()
  // base-ui's Menu.RadioItem renders role="menuitemradio", not "menuitem" --
  // the active branch must be exposed as checked, not only shown visually.
  await expect(page.getByRole('menuitemradio').first()).toBeVisible()
  await expect(page.getByRole('menuitemradio', { checked: true })).toHaveCount(1)
  await ctx.close()
})

test('a theme key the form does not know is refused in Indonesian, not as a 500', async ({ page }) => {
  await page.context().addCookies(await cookiesOf(owner))
  await page.goto('/dashboard/settings')
  // Wait for hydration structurally: the colour well mirrors the hex box only
  // through React state, so once it follows a typed value the form is live and
  // no later commit will re-sync the radio's value attribute before submit.
  const hex = page.locator('#brandColor')
  await hex.fill('#123456')
  await expect(page.locator('input[type="color"]')).toHaveValue('#123456')
  await hex.fill('')
  await page.evaluate(() => {
    const el = document.querySelector('input[name="theme"]:checked') as HTMLInputElement
    el.value = 'pink'
  })
  await page.getByRole('button', { name: 'Simpan tampilan' }).click()
  await expect(page.getByText('Pilih salah satu tema yang tersedia.')).toBeVisible()
})

test('signing out from a dark salon leaves /login light', async ({ browser }) => {
  // Spec §6.3: the shell removes data-theme on unmount so a soft navigation
  // to /login is not left dark. Own login so the shared owner session, which
  // other tests still read, is not the one being revoked.
  const ctx = await browser.newContext()
  const fresh = await signIn(`owner@${DOMAIN}`, PW)
  await ctx.addCookies((await fresh.storageState()).cookies)
  const page = await ctx.newPage()
  await page.goto('/dashboard')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.getByRole('button', { name: /Shell Owner/ }).click()
  await page.getByRole('menuitem', { name: 'Keluar' }).click()
  await expect(page).toHaveURL(/\/login/)
  await expect(page.locator('html')).not.toHaveAttribute('data-theme')
  await ctx.close()
})
