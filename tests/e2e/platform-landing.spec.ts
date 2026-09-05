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
    expect(body).toContain('Belum semuanya ada')
    // The two admissions that would age worst if the page quietly dropped
    // them: that WhatsApp does not actually send, and that online payment is
    // not wired. Asserted on meaning rather than on the old chip labels --
    // the honesty moved from a nine-item register into prose, and the test
    // should follow the claim, not the markup it used to live in.
    expect(body, 'the page must still admit WhatsApp does not send')
      .toContain('belum benar-benar terkirim')
    expect(body, 'and that online payment is not wired')
      .toContain('pembayaran online')
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

  test('every product capture actually loads', async ({ page }) => {
    // The page is a guided tour of real screenshots; a 404 on one of them is a
    // broken landing page, and no other test looks at public/.
    await page.goto('/')
    const imgs = page.locator('main img')
    await expect(imgs).toHaveCount(4)
    for (let i = 0; i < 4; i++) {
      const el = imgs.nth(i)
      await expect(el).toBeVisible()
      // naturalWidth is 0 for an image the browser could not decode.
      expect(await el.evaluate((n: HTMLImageElement) => n.naturalWidth),
        `capture ${i} must decode`).toBeGreaterThan(0)
      // Real alt text, not a filename — these carry the tour for a screen reader.
      expect((await el.getAttribute('alt') ?? '').length).toBeGreaterThan(30)
    }
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
    // --color-paper, not --color-accent: the app's own shadcn theme defines an
    // `--color-accent` too, so that name is defined on /login either way and
    // the probe passed for the wrong reason. --color-paper exists only in the
    // Hallmark tokens.
    const paper = (el: Element) =>
      getComputedStyle(el).getPropertyValue('--color-paper').trim()

    await page.goto('/')
    expect(await page.locator('.hm').evaluate(paper),
      'the landing page defines its own palette').not.toBe('')

    await page.goto('/login')
    expect(await page.locator('body').evaluate(paper),
      'the app must not see the marketing palette').toBe('')
  })
})
