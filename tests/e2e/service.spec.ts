import { expect, request, test } from '@playwright/test'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from '../db'
import { createLogin, createSalon, signIn } from './fixtures'
import { formatMoney } from '../../lib/money'

/**
 * Guards, redirects, form posts, per-branch override forms, the performers
 * checklist and the RSC payload -- driven over HTTP against the running app.
 * Schema, constraints, the service_branch_pricing resolution view and the
 * create-vs-currency-change concurrency race live in tests/service.db.test.ts
 * instead -- a SQL assertion (or two deterministic pg connections) covers
 * those better than forcing them through HTTP. Money parsing/formatting is
 * tests/money.test.ts.
 *
 * The Origin header is not optional: better-auth's CSRF check rejects a
 * state-changing call without one (MISSING_OR_NULL_ORIGIN, 403). See
 * tests/e2e/ui.spec.ts.
 */
const DOMAIN = 'svccheck.local'
const PW = 'demo12345'
const BASE_URL = 'http://localhost:3100'

const pool = new Pool({ connectionString: TEST_DATABASE_URL })

const client = () => request.newContext({
  maxRedirects: 0,
  extraHTTPHeaders: { origin: BASE_URL },
})

const setPlan = (organizationId: string, key: string) => pool.query(`
  update subscriptions set plan_id = (select id from plans where key = $2)
   where organization_id = $1`, [organizationId, key])

const defaultTeamOf = async (organizationId: string) => (await pool.query(
  `select id from teams where organization_id = $1 order by created_at limit 1`,
  [organizationId])).rows[0].id as string

/**
 * Server actions render as plain, no-JS-fallback HTML forms -- a hidden
 * input per bound argument -- so a real POST needs those hidden fields
 * copied through verbatim, not just the fields a human would type. Ported
 * from the shell script this suite replaces (scripts/service-check.mjs),
 * which discovered this shape the same way: by running it.
 */
const decodeHtml = (t: string) => t.replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

const getPage = async (ctx: Awaited<ReturnType<typeof client>>, path: string) => {
  const r = await ctx.get(path)
  return { status: r.status(), html: await r.text() }
}

const hiddenFieldsOf = (formChunk: string) => [...formChunk.slice(0, formChunk.indexOf('</form>')).matchAll(
  /<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?\s*\/>/g)]

const submitForm = async (
  ctx: Awaited<ReturnType<typeof client>>, path: string, marker: string,
  fields: Record<string, string> = {},
) => {
  const page = await getPage(ctx, path)
  const form = page.html.split('<form').find((f) => f.includes(marker))
  if (!form) throw new Error(`no form matching ${marker} on ${path} (status ${page.status})`)
  const multipart: Record<string, string> = {}
  for (const [, k, v] of hiddenFieldsOf(form)) multipart[decodeHtml(k)] = decodeHtml(v ?? '')
  Object.assign(multipart, fields)
  const r = await ctx.post(path, { multipart, maxRedirects: 0 })
  return { status: r.status(), location: r.headers()['location'], html: await r.text() }
}

const priceAt = async (serviceId: string, teamId: string) => (await pool.query(`
  select price, offered, currency from service_branch_pricing
   where service_id = $1 and team_id = $2`, [serviceId, teamId])).rows[0]

const serviceIdByName = async (organizationId: string, name: string) => (await pool.query(
  `select id from services where organization_id = $1 and name = $2`,
  [organizationId, name])).rows[0]?.id as string | undefined

let FREE: { caps: { services: number } }

test.beforeAll(async () => {
  const { PLANS } = await import('../../scripts/seed-plans.mjs')
  FREE = PLANS.find((p: { key: string }) => p.key === 'free') as typeof FREE
  await pool.query(`delete from organizations where slug like 'svccheck%' or id = 'svc_foreign_org'`)
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`])
})

test.afterAll(async () => {
  // Restore from the seed export, never from the live table -- reading the
  // live value after a crashed run is what would launder a corrupted cap
  // forward to the next one.
  await pool.query(`
    update plan_limits set cap = $1
     where plan_id = (select id from plans where key = 'free') and resource = 'services'`,
    [FREE.caps.services])
  await pool.end()
})

test.describe.serial('catalogue guards, duplicate names and cross-tenant lookups', () => {
  let owner: Awaited<ReturnType<typeof client>>
  let orgId: string
  let branchId: string

  test.beforeAll(async () => {
    owner = await client()
    ;({ ctx: owner, organizationId: orgId } = await createSalon(pool, {
      name: 'Svc List Owner', email: `list-owner@${DOMAIN}`, password: PW,
      salon: 'Svc Check List', slug: 'svccheck-list',
    }))
    branchId = await defaultTeamOf(orgId)
  })
  test.afterAll(() => owner.dispose())

  test('creating a service redirects to /services', async () => {
    const created = await submitForm(owner, '/dashboard/services/new', 'name="price"', {
      name: 'Potong Rambut', durationMinutes: '60', price: '150000',
    })
    expect(created.status, created.html).toBe(303)
    expect(created.location ?? '').toContain('/dashboard/services')
  })

  test('a duplicate name is refused case-insensitively, not redirected', async () => {
    const dup = await submitForm(owner, '/dashboard/services/new', 'name="price"', {
      name: 'potong rambut', durationMinutes: '45', price: '99000',
    })
    expect(dup.status).toBe(200)
    expect(dup.html).toContain('Layanan dengan nama ini sudah ada.')
    const { rows } = await pool.query(
      `select count(*)::int n from services where organization_id = $1 and lower(name) = 'potong rambut'`,
      [orgId])
    expect(rows[0].n).toBe(1)
  })

  test('front desk is redirected away from /services', async () => {
    const email = `list-desk@${DOMAIN}`
    const made = await owner.post('/api/staff', {
      data: { name: 'Svc List Desk', email, password: PW, role: 'frontdesk', branchId },
    })
    expect(made.status(), await made.text()).toBe(201)

    const desk = await client()
    await desk.post('/api/auth/sign-in/email', { data: { email, password: PW } })
    const res = await desk.get('/dashboard/services')
    expect(res.status(), `got ${res.status()}`).toBe(307)
    expect(res.headers()['location'] ?? '').toContain('/dashboard')
    await desk.dispose()
  })

  test('a stylist is likewise redirected away from /services', async () => {
    const email = `list-stylist@${DOMAIN}`
    const made = await owner.post('/api/staff', {
      data: { name: 'Svc List Stylist', email, password: PW, role: 'stylist', branchId },
    })
    expect(made.status(), await made.text()).toBe(201)

    const stylist = await client()
    await stylist.post('/api/auth/sign-in/email', { data: { email, password: PW } })
    const res = await stylist.get('/dashboard/services')
    expect(res.status(), `got ${res.status()}`).toBe(307)
    expect(res.headers()['location'] ?? '').toContain('/dashboard')
    await stylist.dispose()
  })

  test("another salon's service id is not found and leaks no name, and never leaks into this salon's own list", async () => {
    // A complete fixture -- a real category AND a real service in a foreign
    // org -- not a bare row missing something the list query joins on. An
    // incomplete fixture is exactly how earlier assertions in this project
    // passed for the wrong reason (see tests/README.md).
    await pool.query(`
      insert into organizations (id, name, slug, created_at)
      values ('svc_foreign_org', 'Foreign', 'svccheck-foreign', now())`)
    await pool.query(`
      insert into service_categories (id, organization_id, name)
      values ('svc_foreign_cat', 'svc_foreign_org', 'Perawatan Rambut')`)
    await pool.query(`
      insert into services (id, organization_id, category_id, name, duration_minutes, price)
      values ('svc_foreign_svc', 'svc_foreign_org', 'svc_foreign_cat', 'Rebonding Salon Lain', 120, 500000)`)

    const crossPage = await getPage(owner, '/dashboard/services/svc_foreign_svc')
    expect(crossPage.status).not.toBe(200)
    expect(crossPage.html).not.toContain('Rebonding Salon Lain')

    const ownList = await getPage(owner, '/dashboard/services')
    expect(ownList.html).not.toContain('Rebonding Salon Lain')
    expect(ownList.html).not.toContain('Perawatan Rambut')
  })
})

test.describe.serial('the detail screen and per-branch overrides', () => {
  let owner: Awaited<ReturnType<typeof client>>
  let orgId: string
  let teamA: string
  let teamB: string
  let serviceId: string
  let path: string

  test.beforeAll(async () => {
    ;({ ctx: owner, organizationId: orgId } = await createSalon(pool, {
      name: 'Svc Ovr Owner', email: `ovr-owner@${DOMAIN}`, password: PW,
      salon: 'Svc Check Overrides', slug: 'svccheck-overrides',
    }))
    // Business plan so the branch cap never interferes with the two extra
    // branches this fixture needs.
    await setPlan(orgId, 'business')
    const branchA = await owner.post('/api/auth/organization/create-team',
      { data: { name: 'Cabang Utama Ovr', organizationId: orgId } })
    const branchB = await owner.post('/api/auth/organization/create-team',
      { data: { name: 'Cabang Kedua Ovr', organizationId: orgId } })
    teamA = (await branchA.json()).id
    teamB = (await branchB.json()).id

    const created = await submitForm(owner, '/dashboard/services/new', 'name="price"',
      { name: 'Creambath Premium', durationMinutes: '40', price: '100000' })
    expect(created.status, created.html).toBe(303)
    serviceId = (await serviceIdByName(orgId, 'Creambath Premium'))!
    expect(serviceId).toBeTruthy()
    path = `/dashboard/services/${serviceId}`
  })
  test.afterAll(() => owner.dispose())

  test('setting branch A to the same number as the salon price is still an override', async () => {
    // Both branches start offered (checkboxes default checked, so 'on' is
    // what a real submit of the unedited row would send).
    const step1 = await submitForm(owner, path, 'name="serviceId"', {
      [`price-${teamA}`]: '100000', [`offered-${teamA}`]: 'on',
      [`price-${teamB}`]: '', [`offered-${teamB}`]: 'on',
    })
    expect(step1.status, step1.html).toBe(200)
    expect(step1.html).toContain('Harga per cabang diperbarui.')
  })

  const updatePrice = (price: number) => submitForm(owner, path, 'name="price"',
    { name: 'Creambath Premium', durationMinutes: '40', price: String(price) })

  test('branch A stays on its own number after a salon price change, while branch B (inheriting) follows it', async () => {
    const afterRaise = await updatePrice(130000)
    expect(afterRaise.status, afterRaise.html).toBe(200)
    expect(afterRaise.html).toContain('Layanan diperbarui.')

    expect(Number((await priceAt(serviceId, teamA)).price)).toBe(100000)
    expect(Number((await priceAt(serviceId, teamB)).price)).toBe(130000)
  })

  test('clearing branch A\'s override returns it to inheriting, and the NEXT salon change reaches it too', async () => {
    const step2 = await submitForm(owner, path, 'name="serviceId"', {
      [`price-${teamA}`]: '', [`offered-${teamA}`]: 'on',
      [`price-${teamB}`]: '', [`offered-${teamB}`]: 'on',
    })
    expect(step2.status, step2.html).toBe(200)
    expect(step2.html).toContain('Harga per cabang diperbarui.')
    expect(Number((await priceAt(serviceId, teamA)).price)).toBe(130000)

    const afterSecondRaise = await updatePrice(150000)
    expect(afterSecondRaise.status, afterSecondRaise.html).toBe(200)
    expect(Number((await priceAt(serviceId, teamA)).price)).toBe(150000)
  })

  test('toggling branch B\'s offered flag leaves branch A\'s price and offered state untouched', async () => {
    const step3 = await submitForm(owner, path, 'name="serviceId"', {
      [`price-${teamA}`]: '', [`offered-${teamA}`]: 'on',
      [`price-${teamB}`]: '', // offered-teamB omitted -- an unchecked checkbox submits nothing
    })
    expect(step3.status, step3.html).toBe(200)
    expect(step3.html).toContain('Harga per cabang diperbarui.')
    expect((await priceAt(serviceId, teamB)).offered).toBe(false)
    expect((await priceAt(serviceId, teamA)).offered).toBe(true)
    expect(Number((await priceAt(serviceId, teamA)).price)).toBe(150000)
  })

  test('a submit naming a foreign branch does not error and writes nothing for it', async () => {
    const step4 = await submitForm(owner, path, 'name="serviceId"', {
      [`price-${teamA}`]: '', [`offered-${teamA}`]: 'on',
      [`price-${teamB}`]: '',
      'price-svc_foreign_team': '999000', 'offered-svc_foreign_team': 'on',
    })
    expect(step4.status, step4.html).toBe(200)
    expect(step4.html).toContain('Harga per cabang diperbarui.')
    const { rows } = await pool.query(`
      select count(*)::int n from service_branch_overrides
       where service_id = $1 and team_id = 'svc_foreign_team'`, [serviceId])
    expect(rows[0].n).toBe(0)
  })

  test('a stale form (missing a branch created after it loaded) leaves that branch untouched, while a branch the form rendered and left unchecked is genuinely set not-offered', async () => {
    const preLoadPage = await getPage(owner, path)
    const teamCResp = await owner.post('/api/auth/organization/create-team',
      { data: { name: 'Cabang Setelah Form Dimuat', organizationId: orgId } })
    const teamC = (await teamCResp.json()).id
    expect(teamC).toBeTruthy()
    // A known prior state, standing in for "whatever this branch already
    // held" -- proves it SURVIVES the submit, not merely that no new row
    // appears.
    await pool.query(`
      insert into service_branch_overrides (service_id, team_id, organization_id, price, offered)
      values ($1, $2, $3, 222000, true)`, [serviceId, teamC, orgId])

    const staleForm = preLoadPage.html.split('<form').find((f) => f.includes('name="serviceId"'))!
    const multipart: Record<string, string> = {}
    for (const [, k, v] of hiddenFieldsOf(staleForm)) multipart[decodeHtml(k)] = decodeHtml(v ?? '')
    multipart[`price-${teamA}`] = ''
    multipart[`offered-${teamA}`] = 'on'
    multipart[`price-${teamB}`] = ''
    // offered-teamB stays omitted, same as the previous test -- branch B
    // stays not-offered.
    const staleResp = await owner.post(path, { multipart, maxRedirects: 0 })
    expect(staleResp.status(), await staleResp.text()).toBe(200)
    expect(await staleResp.text()).toContain('Harga per cabang diperbarui.')

    const teamCAfter = await priceAt(serviceId, teamC)
    expect(Number(teamCAfter.price)).toBe(222000)
    expect(teamCAfter.offered).toBe(true)
    expect((await priceAt(serviceId, teamB)).offered).toBe(false)
  })
})

test.describe.serial('the plan cap counts active services only', () => {
  let owner: Awaited<ReturnType<typeof client>>
  let orgId: string

  test.beforeAll(async () => {
    ;({ ctx: owner, organizationId: orgId } = await createSalon(pool, {
      name: 'Svc Cap Owner', email: `cap-owner@${DOMAIN}`, password: PW,
      salon: 'Svc Check Cap', slug: 'svccheck-cap',
    }))
  })
  test.afterAll(async () => {
    await owner.dispose()
    await pool.query(`
      update plan_limits set cap = $1
       where plan_id = (select id from plans where key = 'free') and resource = 'services'`,
      [FREE.caps.services])
  })

  test('creation at the cap is refused, then succeeds once a deactivation frees a slot', async () => {
    const first = await submitForm(owner, '/dashboard/services/new', 'name="price"',
      { name: 'Layanan Cap Satu', durationMinutes: '30', price: '50000' })
    expect(first.status, first.html).toBe(303)

    // Cap set to the current active count -- the tenant is now exactly full.
    await pool.query(`
      update plan_limits set cap = 1
       where plan_id = (select id from plans where key = 'free') and resource = 'services'`)

    const refused = await submitForm(owner, '/dashboard/services/new', 'name="price"',
      { name: 'Layanan Cap Dua', durationMinutes: '30', price: '60000' })
    expect(refused.status).toBe(200)
    expect(refused.html).toContain('Kuota layanan paket Anda sudah tercapai. Upgrade untuk menambah layanan.')

    const { rows: [afterRefusal] } = await pool.query(
      `select count(*)::int n from services where organization_id = $1`, [orgId])
    expect(afterRefusal.n).toBe(1)

    // Free the slot with direct SQL -- deactivateServiceAction is exercised
    // for real in the reactivation test below; this fixture just needs an
    // inactive filler that counts for nothing.
    await pool.query(`
      update services set active = false
       where organization_id = $1 and name = 'Layanan Cap Satu'`, [orgId])

    // "Deactivation frees a slot" is proven the real way: a creation that
    // was refused now succeeds, not by re-running a count query, which would
    // pass even if countResource never excluded inactive rows at all.
    const afterFree = await submitForm(owner, '/dashboard/services/new', 'name="price"',
      { name: 'Layanan Cap Dua', durationMinutes: '30', price: '60000' })
    expect(afterFree.status, afterFree.html).toBe(303)

    const { rows: [afterSuccess] } = await pool.query(
      `select count(*)::int n from services where organization_id = $1`, [orgId])
    expect(afterSuccess.n).toBe(2) // one deactivated, one active
  })

  test('reactivating at the cap is refused, and the service stays inactive', async () => {
    // A second, active filler inserted directly -- fixture setup, not the
    // path under test (creation is already covered above). Once the cap is
    // pinned to 1, this filler alone fills it, so the target service being
    // deactivated/reactivated is what decides the outcome.
    await pool.query(`
      insert into services (id, organization_id, name, duration_minutes, price)
      values ('svc_react_filler', $1, 'Layanan Pengisi', 30, 40000)`, [orgId])
    await pool.query(`
      update plan_limits set cap = 1
       where plan_id = (select id from plans where key = 'free') and resource = 'services'`)

    const targetId = (await serviceIdByName(orgId, 'Layanan Cap Dua'))!

    // Asserted by the button label flipping, not a "done" alert: the status
    // form's action ref is `active ? deactivate... : reactivate...`, and a
    // successful flip re-renders with a DIFFERENT action bound to the same
    // useActionState call, so a plain HTML re-render carries the new label.
    const deactivated = await submitForm(owner, `/dashboard/services/${targetId}`, 'Nonaktifkan layanan</button>')
    expect(deactivated.status, deactivated.html).toBe(200)
    expect(deactivated.html).toContain('Aktifkan layanan</button>')
    expect(deactivated.html).not.toContain('Nonaktifkan layanan</button>')
    const { rows: [afterDeactivate] } = await pool.query(
      `select active from services where id = $1`, [targetId])
    expect(afterDeactivate.active).toBe(false)

    // The filler alone (still active) now equals the cap, so reactivating
    // the target must be refused.
    const reactivated = await submitForm(owner, `/dashboard/services/${targetId}`, 'Aktifkan layanan</button>')
    expect(reactivated.status).toBe(200)
    expect(reactivated.html).toContain('Kuota layanan paket Anda sudah tercapai. Upgrade untuk menambah layanan.')
    const { rows: [afterRefusal] } = await pool.query(
      `select active from services where id = $1`, [targetId])
    expect(afterRefusal.active).toBe(false)
  })
})

test.describe.serial('who performs a service', () => {
  let owner: Awaited<ReturnType<typeof client>>
  let orgId: string
  let branchId: string
  let stylistId: string
  let adminId: string
  let serviceId: string
  let path: string

  test.beforeAll(async () => {
    // Free plan is enough: 1 branch, and owner + admin + stylist is exactly
    // 3 staff (the free cap).
    ;({ ctx: owner, organizationId: orgId } = await createSalon(pool, {
      name: 'Svc Perf Owner', email: `perf-owner@${DOMAIN}`, password: PW,
      salon: 'Svc Check Performers', slug: 'svccheck-performers',
    }))
    branchId = await defaultTeamOf(orgId)

    const stylistEmail = `perf-stylist@${DOMAIN}`
    const madeStylist = await owner.post('/api/staff', {
      data: { name: 'Svc Perf Stylist', email: stylistEmail, password: PW, role: 'stylist', branchId },
    })
    expect(madeStylist.status(), await madeStylist.text()).toBe(201)
    stylistId = (await madeStylist.json()).user.id

    // An admin, deliberately with NO branchId -- spec §8's known gap. team_id
    // stays null, so this is the "not eligible" fixture below.
    const adminEmail = `perf-admin@${DOMAIN}`
    const madeAdmin = await owner.post('/api/staff', {
      data: { name: 'Svc Perf Admin', email: adminEmail, password: PW, role: 'admin' },
    })
    expect(madeAdmin.status(), await madeAdmin.text()).toBe(201)
    adminId = (await madeAdmin.json()).user.id

    const created = await submitForm(owner, '/dashboard/services/new', 'name="price"',
      { name: 'Creambath Performer', durationMinutes: '30', price: '80000' })
    expect(created.status, created.html).toBe(303)
    serviceId = (await serviceIdByName(orgId, 'Creambath Performer'))!
    path = `/dashboard/services/${serviceId}`
  })
  test.afterAll(() => owner.dispose())

  test('the eligible stylist is offered as a candidate; a staff member with no branch is not', async () => {
    const page = await getPage(owner, path)
    expect(page.html).toContain(`name="performer-${stylistId}"`)
    expect(page.html).not.toContain(`name="performer-${adminId}"`)
  })

  test('checking, then unchecking, the stylist creates and removes a service_staff row', async () => {
    const checked = await submitForm(owner, path, 'name="performer-', { [`performer-${stylistId}`]: 'on' })
    expect(checked.status, checked.html).toBe(200)
    expect(checked.html).toContain('Staf layanan diperbarui.')
    const { rows: [linked] } = await pool.query(`
      select count(*)::int n from service_staff
       where service_id = $1 and user_id = $2 and organization_id = $3`,
      [serviceId, stylistId, orgId])
    expect(linked.n).toBe(1)

    // Submitting the set with the field simply omitted, same as an unchecked
    // checkbox.
    const unchecked = await submitForm(owner, path, 'name="performer-', {})
    expect(unchecked.status, unchecked.html).toBe(200)
    const { rows: [unlinked] } = await pool.query(`
      select count(*)::int n from service_staff
       where service_id = $1 and user_id = $2 and organization_id = $3`,
      [serviceId, stylistId, orgId])
    expect(unlinked.n).toBe(0)
  })

  test('a stylist deactivated after being linked keeps their link across an unrelated performers edit', async () => {
    const relinked = await submitForm(owner, path, 'name="performer-', { [`performer-${stylistId}`]: 'on' })
    expect(relinked.status, relinked.html).toBe(200)

    await pool.query(`update staff_profiles set active = false where user_id = $1`, [stylistId])
    const pageAfterLeave = await getPage(owner, path)
    expect(pageAfterLeave.html).not.toContain(`name="performer-${stylistId}"`)

    // 'Simpan staf' rather than 'name="performer-' -- with zero candidates
    // left, the form renders no checkboxes at all, only its own button. The
    // bug this guards: an unrelated edit's delete scoped to "everyone but
    // checkedIds" (rather than "candidates minus checkedIds") would sweep up
    // this row even though the stylist is no longer even a candidate.
    const uncheckedByAll = await submitForm(owner, path, 'Simpan staf', {})
    expect(uncheckedByAll.status, uncheckedByAll.html).toBe(200)
    const { rows: [survived] } = await pool.query(`
      select count(*)::int n from service_staff
       where service_id = $1 and user_id = $2 and organization_id = $3`,
      [serviceId, stylistId, orgId])
    expect(survived.n).toBe(1)
    await pool.query(`update staff_profiles set active = true where user_id = $1`, [stylistId])
  })
})

test.describe.serial('currency at onboarding, and locking it once priced', () => {
  let owner: Awaited<ReturnType<typeof client>>
  let orgId: string

  const currencyOf = async () => (await pool.query(
    `select currency from salon_profiles where organization_id = $1`, [orgId])).rows[0].currency as string

  test.beforeAll(async () => {
    await createLogin(pool, { name: 'Svc Currency Owner', email: `cur-owner@${DOMAIN}`, password: PW })
    owner = await signIn(`cur-owner@${DOMAIN}`, PW)
  })
  test.afterAll(() => owner.dispose())

  test('onboarding with SGD redirects to /dashboard and overwrites the trigger-seeded IDR default', async () => {
    const onboarded = await submitForm(owner, '/dashboard/onboarding', 'name="slug"',
      { name: 'Svc Check Currency', slug: 'svccheck-currency', currency: 'SGD' })
    expect(onboarded.status, onboarded.html).toBe(303)
    expect(onboarded.location ?? '').toContain('/dashboard')

    const { rows: [org] } = await pool.query(`select id from organizations where slug = 'svccheck-currency'`)
    orgId = org.id
    expect(await currencyOf()).toBe('SGD')
  })

  test('currency is changeable while the catalogue is empty, and an unrecognised code is refused without storing anything', async () => {
    const changed = await submitForm(owner, '/dashboard/services', 'name="currency"', { currency: 'MYR' })
    expect(changed.status, changed.html).toBe(200)
    expect(changed.html).toContain('Mata uang disimpan.')
    expect(await currencyOf()).toBe('MYR')

    // isCurrencyCode must refuse this before the guarded UPDATE ever runs.
    const bogus = await submitForm(owner, '/dashboard/services', 'name="currency"', { currency: 'ZZZ' })
    expect(bogus.status).toBe(200)
    expect(bogus.html).toContain('Mata uang tidak dikenali.')
    expect(await currencyOf()).toBe('MYR')
  })

  test('once a service exists, a currency change (submitted from a stale, already-loaded empty-catalogue form) is refused with the 409 copy, and the read-only line then renders', async () => {
    // The currency card only renders a FORM while the catalogue is empty
    // (once a service exists it collapses to a read-only line) -- captured
    // once here so this test can still submit it after that service exists.
    // That is not a workaround: it is exactly the shape of the race the
    // guard exists for -- a browser tab left open on the empty-catalogue
    // page, submitted after a service was created in another tab.
    const emptyPage = await getPage(owner, '/dashboard/services')
    const currencyForm = emptyPage.html.split('<form').find((f) => f.includes('name="currency"'))
    if (!currencyForm) throw new Error('no currency form found while the catalogue is empty')
    const staleHidden = hiddenFieldsOf(currencyForm)

    const created = await submitForm(owner, '/dashboard/services/new', 'name="price"',
      { name: 'Layanan Mata Uang', durationMinutes: '30', price: '50' })
    expect(created.status, created.html).toBe(303)

    const multipart: Record<string, string> = {}
    for (const [, k, v] of staleHidden) multipart[decodeHtml(k)] = decodeHtml(v ?? '')
    multipart.currency = 'IDR'
    const refused = await owner.post('/dashboard/services', { multipart, maxRedirects: 0 })
    expect(refused.status()).toBe(200)
    const refusedHtml = await refused.text()
    expect(refusedHtml).toContain('Mata uang tidak dapat diubah setelah ada layanan berharga.')
    expect(await currencyOf()).toBe('MYR')
    expect(refusedHtml).toContain('sudah ada layanan berharga')
  })
})

test.describe.serial('a price entered in a 2-exponent currency stores the right minor units', () => {
  test('250.50 SGD is stored as 25050 -- not 250 (truncated) or 2505050 (10x) -- and the list renders it back identically', async () => {
    const email = `sgd-owner@${DOMAIN}`
    await createLogin(pool, { name: 'Svc SGD Owner', email, password: PW })
    const owner = await signIn(email, PW)

    const onboarded = await submitForm(owner, '/dashboard/onboarding', 'name="slug"',
      { name: 'Svc Check SGD', slug: 'svccheck-sgd', currency: 'SGD' })
    expect(onboarded.status, onboarded.html).toBe(303)
    const { rows: [org] } = await pool.query(`select id from organizations where slug = 'svccheck-sgd'`)
    const orgId = org.id

    const created = await submitForm(owner, '/dashboard/services/new', 'name="price"',
      { name: 'Layanan SGD', durationMinutes: '30', price: '250.50' })
    expect(created.status, created.html).toBe(303)

    const { rows: [row] } = await pool.query(
      `select price from services where organization_id = $1 and name = 'Layanan SGD'`, [orgId])
    expect(Number(row?.price)).toBe(25050)

    const listPage = await getPage(owner, '/dashboard/services')
    expect(decodeHtml(listPage.html)).toContain(formatMoney(25050, 'SGD'))
    await owner.dispose()
  })
})

test.describe('a concurrent service-creation + currency-change race never lets both land (HTTP-level)', () => {
  // Supplementary to the deterministic two-connection test in
  // tests/service.db.test.ts, which forces both lock orderings directly.
  // This one is worth keeping alongside it because it is the only test in
  // this suite that exercises createServiceAction and setCurrencyAction
  // together, over real HTTP, through the real dev server -- the shape the
  // bug actually shipped in. Fewer trials than the old shell script's 15
  // (without the guard it reproduced 15/15): the deterministic test already
  // covers the exhaustive case, this is a sanity net.
  test('never corrupts price/currency agreement', async () => {
    const RACE_TRIALS = 8
    let corrupted = 0
    for (let n = 0; n < RACE_TRIALS; n++) {
      const email = `race-${n}@${DOMAIN}`
      await createLogin(pool, { name: `Race Owner ${n}`, email, password: PW })
      const owner = await signIn(email, PW)
      await submitForm(owner, '/dashboard/onboarding', 'name="slug"',
        { name: `Race Salon ${n}`, slug: `svccheck-race-${n}`, currency: 'IDR' })
      const { rows: [org] } = await pool.query(
        `select id from organizations where slug = $1`, [`svccheck-race-${n}`])
      const orgId = org.id

      // Capture both forms' hidden fields BEFORE firing either POST -- this
      // is what the race actually looks like: two requests against the same
      // empty-catalogue state, submitted at the same instant.
      const svcPage = await getPage(owner, '/dashboard/services/new')
      const svcForm = svcPage.html.split('<form').find((f) => f.includes('name="price"'))!
      const curPage = await getPage(owner, '/dashboard/services')
      const curForm = curPage.html.split('<form').find((f) => f.includes('name="currency"'))!

      const svcMultipart: Record<string, string> = {}
      for (const [, k, v] of hiddenFieldsOf(svcForm)) svcMultipart[decodeHtml(k)] = decodeHtml(v ?? '')
      svcMultipart.name = 'Layanan Race'
      svcMultipart.durationMinutes = '30'
      svcMultipart.price = '50000'

      const curMultipart: Record<string, string> = {}
      for (const [, k, v] of hiddenFieldsOf(curForm)) curMultipart[decodeHtml(k)] = decodeHtml(v ?? '')
      curMultipart.currency = 'SGD'

      await Promise.all([
        owner.post('/dashboard/services/new', { multipart: svcMultipart, maxRedirects: 0 }),
        owner.post('/dashboard/services', { multipart: curMultipart, maxRedirects: 0 }),
      ])

      const { rows: [profile] } = await pool.query(
        `select currency from salon_profiles where organization_id = $1`, [orgId])
      const { rows: [svc] } = await pool.query(
        `select price from services where organization_id = $1`, [orgId])
      // Corruption is a price/currency MISMATCH, not the mere co-existence of
      // a service and SGD -- "change currency on an empty catalogue, then
      // create under the new one" is a legal sequential outcome and must not
      // count.
      const expected = profile.currency === 'IDR' ? 50000 : 5000000
      if (svc && Number(svc.price) !== expected) corrupted++
      await owner.dispose()
    }
    expect(corrupted, `${corrupted}/${RACE_TRIALS} corrupted`).toBe(0)
  })
})
