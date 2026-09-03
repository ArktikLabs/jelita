import { expect, request, test } from '@playwright/test'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from '../db'
import { BASE_URL } from './fixtures'

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
