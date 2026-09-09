import { expect, request, test } from '@playwright/test'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from '../db'
import { BASE_URL, createSalon } from './fixtures'

/**
 * Search, cross-tenant scoping, permissions and the duplicate-number 409,
 * driven over HTTP against the running app. Phone normalisation lives in
 * tests/phone.test.ts, and the partial unique index / per-salon scoping live
 * in tests/customers.db.test.ts -- a SQL assertion covers those better than
 * forcing them through Playwright.
 *
 * The Origin header is not optional: better-auth's CSRF check rejects a
 * state-changing call without one (MISSING_OR_NULL_ORIGIN, 403). See
 * tests/e2e/ui.spec.ts.
 */
const DOMAIN = 'customercheck.local'
const PW = 'demo12345'

const DUPLICATE_COPY = 'Nomor ini sudah terdaftar untuk pelanggan lain.'

const pool = new Pool({ connectionString: TEST_DATABASE_URL })

// maxRedirects: 0 -- several assertions here are ABOUT the redirect (or its
// absence), same reasoning as tests/e2e/ui.spec.ts.
const client = () => request.newContext({
  maxRedirects: 0,
  extraHTTPHeaders: { origin: BASE_URL },
})

const verify = (email: string) => pool.query(
  `update users set email_verified = true where email = $1`, [email])

test.beforeAll(async () => {
  await pool.query(`delete from organizations where slug like 'customercheck%'`)
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`])
})

test.afterAll(() => pool.end())

test.describe('customer search, scoping, permissions and duplicates', () => {
  let owner: Awaited<ReturnType<typeof client>>
  let stylist: Awaited<ReturnType<typeof client>>
  let orgId: string
  let sariId: string
  let foreignId: string

  test.beforeAll(async () => {
    owner = await client()
    const ownerEmail = `owner@${DOMAIN}`
    await owner.post('/api/auth/sign-up/email',
      { data: { name: 'Cust Owner', email: ownerEmail, password: PW } })
    await verify(ownerEmail)
    await owner.post('/api/auth/sign-in/email', { data: { email: ownerEmail, password: PW } })

    const org = await owner.post('/api/auth/organization/create',
      { data: { name: 'Cust Screens', slug: 'customercheck-screens' } })
    orgId = (await org.json()).id
    await owner.post('/api/auth/organization/set-active', { data: { organizationId: orgId } })

    const org2 = await owner.post('/api/auth/organization/create',
      { data: { name: 'Cust Screens 2', slug: 'customercheck-screens2' } })
    const org2Id = (await org2.json()).id
    // The owner's active org must land back on salon one before the rest of
    // this suite reads/writes against it.
    await owner.post('/api/auth/organization/set-active', { data: { organizationId: orgId } })

    sariId = 'e2e_cust_sari'
    foreignId = 'e2e_cust_foreign'
    await pool.query(`
      insert into customers (id, organization_id, name, phone, phone_key)
      values ($1, $2, 'Sari Wijaya', '+62812999888', '62812999888'),
             ('e2e_cust_budi', $2, 'Budi Santoso', null, null)`, [sariId, orgId])
    // Another salon's customer, to prove a bare id cannot cross tenants.
    await pool.query(`
      insert into customers (id, organization_id, name) values ($1, $2, 'Rahasia Salon Lain')`,
      [foreignId, org2Id])

    // A stylist, membership inserted BEFORE sign-in: lib/auth.ts resolves
    // activeOrganizationId when the session is CREATED, so signing in first
    // would yield a session with no active org, and every guarded page would
    // redirect regardless of permissions -- indistinguishable from a real
    // permissions bug.
    stylist = await client()
    const stylistEmail = `stylist@${DOMAIN}`
    await stylist.post('/api/auth/sign-up/email',
      { data: { name: 'Cust Stylist', email: stylistEmail, password: PW } })
    await verify(stylistEmail)
    const { rows: [su] } = await pool.query(`select id from users where email = $1`, [stylistEmail])
    await pool.query(`
      insert into members (id, user_id, organization_id, role, created_at)
      values ('e2e_cust_m_sty', $1, $2, 'stylist', now())`, [su.id, orgId])
    await stylist.post('/api/auth/sign-in/email', { data: { email: stylistEmail, password: PW } })
  })

  test.afterAll(async () => {
    await owner.dispose()
    await stylist.dispose()
  })

  test('searching a domestic number finds an international-format customer', async () => {
    // Search matches the NORMALISED key, so a domestic spelling finds a
    // customer stored in international form.
    const res = await owner.get('/dashboard/customers?q=0812999888')
    const html = await res.text()
    expect(html).toContain('Sari Wijaya')
  })

  test('and does not return everyone', async () => {
    const res = await owner.get('/dashboard/customers?q=0812999888')
    const html = await res.text()
    expect(html).not.toContain('Budi Santoso')
  })

  test('searching by name works too', async () => {
    const res = await owner.get('/dashboard/customers?q=Budi')
    const html = await res.text()
    expect(html).toContain('Budi Santoso')
  })

  test('another salon customer id is a 404', async () => {
    // Pinned to 404, not merely "not 200": a 500 would also satisfy a looser
    // check and would not leak the name either, so it cannot tell "correctly
    // not-found" from "crashed before rendering".
    const res = await owner.get(`/dashboard/customers/${foreignId}`)
    expect(res.status()).toBe(404)
  })

  test('and their name never appears', async () => {
    const res = await owner.get(`/dashboard/customers/${foreignId}`)
    const html = await res.text()
    expect(html).not.toContain('Rahasia Salon Lain')
  })

  test('creating a duplicate number returns the 409 copy, and writes no row', async ({ browser }) => {
    // A real browser submits the real form -- proving the regex in
    // isDuplicatePhone matches what Postgres actually emits through drizzle's
    // wrapper, with none of the hidden-field extraction or HTML-entity
    // decoding a hand-rolled client needed.
    const context = await browser.newContext({
      storageState: await owner.storageState(), baseURL: BASE_URL,
    })
    try {
      const page = await context.newPage()
      await page.goto('/dashboard/customers/new')
      await page.getByLabel('Nama').fill('Sari Kembar')
      await page.getByLabel('Nomor WhatsApp').fill('0812999888')
      await page.getByRole('button', { name: 'Simpan' }).click()
      await expect(page.getByText(DUPLICATE_COPY)).toBeVisible()
    } finally {
      await context.close()
    }

    const { rows: [{ n }] } = await pool.query(
      `select count(*)::int n from customers where organization_id = $1 and name = 'Sari Kembar'`,
      [orgId])
    expect(n).toBe(0)
  })

  // Task 4 (spec §5): the detail page's audit line.
  test('the detail page names who created it', async ({ browser }) => {
    const context = await browser.newContext({
      storageState: await owner.storageState(), baseURL: BASE_URL,
    })
    try {
      const page = await context.newPage()
      await page.goto('/dashboard/customers/new')
      await page.getByLabel('Nama').fill('Audit Baru')
      await page.getByRole('button', { name: 'Simpan' }).click()
      await expect(page).toHaveURL(/\/dashboard\/customers$/)
    } finally {
      await context.close()
    }
    const { rows: [row] } = await pool.query(
      `select id from customers where organization_id = $1 and name = 'Audit Baru'`, [orgId])
    const res = await owner.get(`/dashboard/customers/${row.id}`)
    const html = await res.text()
    expect(html).toContain('Dibuat oleh Cust Owner')
  })

  test('a customer with no creator on record shows no created line at all -- never a guess, never a dash', async () => {
    // sariId was seeded directly above with no created_by. A null actor
    // there is genuinely ambiguous -- it reads exactly the same for a
    // public-booking customer (findOrCreateByPhone) as for one the seed
    // script inserted raw -- so the page must omit the line entirely
    // rather than assert a source it cannot know, and never fall back to
    // "Dibuat oleh -", which would read as a missing name.
    const res = await owner.get(`/dashboard/customers/${sariId}`)
    const html = await res.text()
    expect(html).not.toContain('Dibuat oleh')
    // The specific regression: an earlier version guessed "the booking
    // page" for ANY null actor, which is false for a row like this one
    // that never went through findOrCreateByPhone at all.
    expect(html).not.toContain('Dibuat dari halaman booking')
  })

  test('a stylist may read the list', async () => {
    const res = await stylist.get('/dashboard/customers')
    expect(res.status()).toBe(200)
  })

  test('but is redirected from create', async () => {
    const res = await stylist.get('/dashboard/customers/new')
    expect(res.status()).toBeGreaterThanOrEqual(300)
    expect(res.status()).toBeLessThan(400)
  })

  test('and from the detail screen', async () => {
    const res = await stylist.get(`/dashboard/customers/${sariId}`)
    expect(res.status()).toBeGreaterThanOrEqual(300)
    expect(res.status()).toBeLessThan(400)
  })
})

/**
 * The URL controls (sort, page, search) added on top of the list contract
 * from tests/list-url.test.ts. Modelled on tests/e2e/payroll.spec.ts's
 * fixture shape -- signed-in via createSalon and a cookie jar, not the raw
 * API-request-context style above, because these assertions are ABOUT what
 * the browser's address bar shows after a click.
 *
 * 60 customers sharing one name so paging and sorting have real work: with
 * fewer rows than a page, or all-unique names, the tiebreaker and the clamp
 * this suite leans on never actually engage.
 */
test.describe('the URL controls', () => {
  const CTRL_DOMAIN = 'custurl.local'
  const CTRL_SLUG = 'custurl'

  let owner: Awaited<ReturnType<typeof createSalon>>['ctx']
  const ownerCookies = async () => (await owner.storageState()).cookies

  test.beforeAll(async () => {
    await pool.query(`delete from organizations where slug like 'custurl%'`)
    await pool.query(`delete from users where email like $1`, [`%@${CTRL_DOMAIN}`])

    const salon = await createSalon(pool, {
      name: 'Ctrl Owner', email: `owner@${CTRL_DOMAIN}`, password: PW,
      salon: 'Ctrl Salon', slug: CTRL_SLUG,
    })
    owner = salon.ctx

    // generate_series rather than 60 literal rows: the point is the count
    // and the shared name, not any one customer's identity.
    await pool.query(`
      insert into customers (id, organization_id, name)
      select 'e2e_curl_' || gs, $1, 'Budi Santoso'
        from generate_series(1, 60) as gs`, [salon.organizationId])
  })

  test.afterAll(async () => {
    await owner.dispose()
    await pool.query(`delete from organizations where slug like 'custurl%'`)
    await pool.query(`delete from users where email like $1`, [`%@${CTRL_DOMAIN}`])
  })

  test('sorting keeps the search', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto('/dashboard/customers?q=Budi')
    await page.getByRole('link', { name: /Nama/ }).click()
    // ONE predicate requiring both at once, not two chained toHaveURL calls:
    // the goto URL above already contains q=Budi, so a first assertion
    // checking only that would trivially match the STALE pre-navigation URL
    // before the sort link's own navigation has landed, and a second
    // assertion checking only `sort=` would pass however q came out --
    // between them, a listHref call that dropped q would slip through
    // undetected. Requiring both on the SAME (post-navigation) URL is what
    // this test exists to catch.
    await expect(page).toHaveURL((url) =>
      url.searchParams.get('q') === 'Budi' && url.searchParams.get('sort') !== null)
  })

  test('searching resets the page', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto('/dashboard/customers?page=3')
    await page.locator('input[name="q"]').fill('Budi')
    await page.locator('input[name="q"]').press('Enter')
    await expect(page).not.toHaveURL(/page=/)
  })

  // Not one of the brief's four scenarios, but the one that actually
  // exercises the hidden `active` input: a search box that silently drops an
  // active filter is the exact URL-state bug listHref exists to prevent, and
  // none of the other cases submit the form with a filter already set.
  test('searching keeps the active filter', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto('/dashboard/customers?active=false')
    await page.locator('input[name="q"]').fill('Budi')
    await page.locator('input[name="q"]').press('Enter')
    // ONE predicate requiring both at once: `active=false` is already true on
    // the pre-navigation goto URL above, so checking it alone would pass
    // without the search's own hidden `active` field ever doing its job.
    // Requiring `q=Budi` too -- true only once the submit has actually
    // landed -- is what makes this assert something new.
    await expect(page).toHaveURL((url) =>
      url.searchParams.get('active') === 'false' && url.searchParams.get('q') === 'Budi')
  })

  // Task 5's FilterBar: the `active` enum filter is a segmented set of
  // links, each routing through listHref -- so, same as every other control
  // on this page, choosing one preserves the sort and resets the page.
  test('filtering keeps the sort', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto('/dashboard/customers?sort=-created')
    await page.getByRole('link', { name: 'Aktif', exact: true }).click()
    // ONE predicate requiring both at once, not two chained toHaveURL calls:
    // the goto URL above already contains `sort=-created`, so a first
    // assertion checking only that would trivially pass on the STALE
    // pre-navigation URL before the click's own navigation has landed --
    // exactly the false pass this test exists to catch (verified against a
    // broken listHref call, which this masked on the first try).
    await expect(page).toHaveURL((url) =>
      url.searchParams.get('sort') === '-created' && url.searchParams.get('active') === 'true')
  })

  test('filtering resets the page', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto('/dashboard/customers?page=3')
    await page.getByRole('link', { name: 'Aktif', exact: true }).click()
    await expect(page).not.toHaveURL(/page=/)
  })

  // The brief's own warning: a filter at its default must not appear in the
  // URL at all -- "Semua" clears it entirely rather than writing e.g.
  // `active=` or the default value back in.
  test('clearing the filter drops it from the URL entirely, not just to its default', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto('/dashboard/customers?active=true')
    await page.getByRole('link', { name: 'Semua' }).click()
    await expect(page).not.toHaveURL(/active=/)
  })

  // A native GET submit replaces the WHOLE query string with only the form's
  // own named fields -- so a sort with no hidden field to carry it forward is
  // silently reset to the default the moment someone searches.
  test('searching keeps the sort', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto('/dashboard/customers?sort=-created')
    await page.locator('input[name="q"]').fill('Budi')
    await page.locator('input[name="q"]').press('Enter')
    // ONE predicate requiring both at once, same reasoning as the two tests
    // above: `sort=-created` is already true on the pre-navigation goto URL,
    // so pairing it with `q=Budi` -- true only once the search has actually
    // submitted -- is what makes the assertion prove the sort survived a
    // REAL search rather than just describing the URL it started from.
    await expect(page).toHaveURL((url) =>
      url.searchParams.get('sort') === '-created' && url.searchParams.get('q') === 'Budi')
  })

  test('a page past the end shows the last page, not an empty table', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto('/dashboard/customers?page=999')
    // 60 seeded customers at 25/page clamp page 999 to page 3, which holds
    // 60 - 50 = 10 rows. The empty state also renders as a `tbody tr` (it's
    // a <TableRow>), so `not.toHaveCount(0)` would pass even with zero real
    // rows -- asserting the exact count is what actually proves the clamp.
    await expect(page.locator('tbody tr')).toHaveCount(10)
  })

  test('the two empty states say different things', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto('/dashboard/customers?q=zzzzznotfound')
    await expect(page.getByText('Tidak ada pelanggan yang cocok')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Hapus filter' })).toBeVisible()

    // The other branch: a salon with no customers at all (as opposed to a
    // search that matched none). A fresh org with nothing seeded is the
    // deterministic way to reach it -- proving this isn't just the same
    // copy rendered for both cases.
    const empty = await createSalon(pool, {
      name: 'Ctrl Empty', email: `empty@${CTRL_DOMAIN}`, password: PW,
      salon: 'Ctrl Empty Salon', slug: `${CTRL_SLUG}-empty`,
    })
    try {
      await page.context().addCookies((await empty.ctx.storageState()).cookies)
      await page.goto('/dashboard/customers')
      await expect(page.getByText('Belum ada pelanggan')).toBeVisible()
    } finally {
      await empty.ctx.dispose()
    }
  })
})
