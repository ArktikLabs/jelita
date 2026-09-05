import { expect, test } from '@playwright/test'

/**
 * The platform landing page — the Hallmark v3 design, ported out of the stash.
 *
 * The assertion that matters most is the LAST one: this page ships a second
 * design system, and the reason it is safe is that Next only sends its
 * stylesheet for this route. If that ever stops being true the dashboard turns
 * cream, and nothing else in the suite would notice.
 */
test.describe('the platform landing page', () => {
  test('the apex serves it', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveTitle(/Jelita/)
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Booking penuh')
  })

  test('every nav anchor has a section to land on', async ({ page }) => {
    await page.goto('/')
    const hrefs = await page.locator('.nav a[href^="#"]').evaluateAll(
      (as) => as.map((a) => a.getAttribute('href')!))
    expect(hrefs.length).toBeGreaterThan(0)
    for (const href of hrefs) {
      await expect(page.locator(href), `${href} must exist`).toHaveCount(1)
    }
  })

  test('it says what is NOT built', async ({ page }) => {
    await page.goto('/')
    const body = await page.locator('body').innerText()
    expect(body).toContain('Yang belum ada')
    // The claims that would age worst if the page quietly dropped them.
    expect(body).toContain('Kirim WhatsApp ke nomor sungguhan')
    expect(body).toContain('Payment gateway live')
  })

  test('the demo figures match what the seed actually builds', async ({ page }) => {
    await page.goto('/')
    // The digits are a pure-CSS counter -- @property --num rendered through
    // `content` -- so they are not in innerText at all. The aria-label is where
    // the real number lives, which is also what a screen reader reads.
    const labels = await page.locator('.counts [aria-label]').evaluateAll(
      (els) => els.map((e) => e.getAttribute('aria-label')!))
    // scripts/seed-demo.ts: two branches, 15 services, 8 staff, 40 customers.
    expect(labels).toContain('2 cabang')
    expect(labels).toContain('15 service')
    expect(labels).toContain('8 staff')
    expect(labels).toContain('40 customer')
  })

  test('fits a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    expect(await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })

  test('its stylesheet does NOT reach the app', async ({ page }) => {
    // Asserted on a token only Hallmark defines, not on a background colour:
    // the ground lives on the .hm wrapper now, so both <body> elements are the
    // same colour and comparing them proves nothing.
    const pear = (sel: string) => (el: Element) =>
      getComputedStyle(el).getPropertyValue('--color-pear').trim()

    await page.goto('/')
    expect(await page.locator('.hm').evaluate(pear('.hm')),
      'the landing page defines its own palette').not.toBe('')

    await page.goto('/login')
    expect(await page.locator('body').evaluate(pear('body')),
      'the app must not see the marketing palette').toBe('')
  })
})
