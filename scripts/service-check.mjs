/**
 * Services catalogue checks. No framework on purpose.
 *   pnpm service:check      (dev server must be running for later sections)
 */
import { Pool } from 'pg'

let pass = 0, fail = 0
const ok = (n, c, d) => (c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${n}`))
                           : (fail++, console.log(`  \x1b[31m✗\x1b[0m ${n}  ${d ?? ''}`)))
const head = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`)

const pool = new Pool({ connectionString: process.env.DIRECT_URL })
const ORG = 'svccheck_org'
const ORG2 = 'svccheck_org2'
const DOMAIN = 'svccheck.local'
const ORIGIN = process.env.BETTER_AUTH_URL
const BASE = `${ORIGIN}/api/auth`
const APP = `${ORIGIN}/api`
const PW = 'demo12345'

// Cookie-jar client, copied from scripts/staff-check.mjs: email verification
// is on, so a freshly signed-up user has no session until verified.
class Client {
  constructor() { this.jar = new Map() }
  async req(path, body, method = 'POST', base = BASE) {
    const headers = { 'content-type': 'application/json', origin: ORIGIN }
    if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ')
    const res = await fetch(base + path, {
      method,
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    })
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const kv = c.split(';')[0], i = kv.indexOf('=')
      const name = kv.slice(0, i), val = kv.slice(i + 1)
      if (val === '') this.jar.delete(name)
      else this.jar.set(name, val)
    }
    const txt = await res.text()
    let data; try { data = JSON.parse(txt) } catch { data = txt }
    return { status: res.status, data }
  }
  get(p) { return this.req(p, undefined, 'GET') }
}

try {
  head('0. reset test fixtures')
  // Unconditional, at the START of every run: later sections reuse fixtures
  // created by earlier ones, so cleanup never happens mid-run (a crash would
  // poison the next run) or at a section's end (a later section needs the row).
  await pool.query(`delete from organizations where slug like 'svccheck%'`)
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`])
  ok('cleared', true)

  head('1. schema')
  const { rows: tables } = await pool.query(`
    select table_name from information_schema.tables
     where table_name in ('salon_profiles','service_categories','services',
                          'service_branch_overrides','service_staff')`)
  ok('all five tables exist', tables.length === 5, `got ${tables.length}`)

  const { rows: rls } = await pool.query(`
    select relname from pg_class
     where relname in ('salon_profiles','service_categories','services',
                       'service_branch_overrides','service_staff')
       and relrowsecurity`)
  ok('RLS enabled on all five', rls.length === 5, `got ${rls.length}`)

  head('2. the trigger seeds salon settings')
  await pool.query(`
    insert into organizations (id, name, slug, created_at)
    values ($1, 'Svc Check', 'svccheck', now())`, [ORG])
  const { rows: [seeded] } = await pool.query(`
    select currency from salon_profiles where organization_id = $1`, [ORG])
  ok('a new salon gets a profile', seeded !== undefined)
  ok('defaulting to IDR', seeded?.currency === 'IDR', `got ${seeded?.currency}`)

  // spec 7.2: the backfill left nobody behind. An organization with no
  // profile row would have no currency, and every price on it unreadable.
  const { rows: [orphan] } = await pool.query(`
    select count(*)::int n from organizations o
     where not exists (select 1 from salon_profiles p
                        where p.organization_id = o.id)`)
  ok('every existing salon has a profile', orphan.n === 0, `got ${orphan.n}`)

  head('3. cross-tenant rows are unrepresentable')
  await pool.query(`
    insert into organizations (id, name, slug, created_at)
    values ($1, 'Svc Check 2', 'svccheck2', now())`, [ORG2])
  await pool.query(`
    insert into teams (id, name, organization_id, created_at)
    values ('svc_t2', 'Other Branch', $1, now())`, [ORG2])
  await pool.query(`
    insert into services (id, organization_id, name, duration_minutes, price)
    values ('svc_s1', $1, 'Potong Rambut', 60, 150000)`, [ORG])

  let refused = false
  try {
    // ORG's service, ORG2's branch, ORG's organization_id -- the composite FK
    // must refuse this outright, not leave it to a WHERE clause somewhere.
    await pool.query(`
      insert into service_branch_overrides (service_id, team_id, organization_id, price)
      values ('svc_s1', 'svc_t2', $1, 99)`, [ORG])
  } catch { refused = true }
  ok('an override pointing at another salon branch is refused', refused)

  // Same shape for service_staff: ORG's service, but a user_id belonging to
  // ORG2's staff_profiles. The composite FK must refuse this too.
  // members_seed_staff_profile (0009) auto-creates the staff_profiles row
  // when the member is inserted -- no explicit insert needed here.
  await pool.query(`
    insert into users (id, name, email, email_verified, created_at, updated_at)
    values ('svc_u2', 'Other Staff', $1, true, now(), now())`,
    [`other-staff@${DOMAIN}`])
  await pool.query(`
    insert into members (id, user_id, organization_id, role, created_at)
    values ('svc_m2', 'svc_u2', $1, 'member', now())`, [ORG2])

  let staffRefused = false
  try {
    await pool.query(`
      insert into service_staff (service_id, user_id, organization_id)
      values ('svc_s1', 'svc_u2', $1)`, [ORG])
  } catch { staffRefused = true }
  ok('a staff link pointing at another salon staff member is refused', staffRefused)

  head('4. money is minor units')
  const { formatMoney, toAmountInput, parseMoney } = await import('../lib/money.ts')
  ok('IDR has no minor digits', formatMoney(150000, 'IDR').includes('150.000'))
  ok('USD has two', formatMoney(15050, 'USD') === '$150.50', formatMoney(15050, 'USD'))

  // Table-driven: every case is [input, currency, expected minor units].
  // '1.500' USD is deliberately null -- it could be 1,500 or 1.50 and no
  // rule distinguishes them, so the parser refuses rather than guessing.
  const parseCases = [
    ['150.000', 'IDR', 150000],
    ['1.500.000', 'IDR', 1500000],
    ['150.5', 'USD', 15050],
    ['150.50', 'USD', 15050],
    ['1,500.50', 'USD', 150050],
    ['150', 'USD', 15000],
    ['1.500', 'USD', null],
    ['abc', 'USD', null],
    ['', 'USD', null],
    ['-5', 'IDR', null],
    ['9.5', 'USD', 950],
  ]
  for (const [input, currency, expected] of parseCases) {
    const got = parseMoney(input, currency)
    ok(`parseMoney(${JSON.stringify(input)}, ${currency}) === ${expected}`,
       got === expected, `got ${got}`)
  }

  // The heuristic this replaces guessed '.' as decimal-vs-grouping by
  // counting trailing digits against the exponent, so '150.5' (one decimal
  // digit) was silently reinterpreted as a thousands separator -- a 10x
  // overcharge, not an error. This is the one assertion standing between
  // that bug and production.
  ok('a one-decimal USD amount is not a 10x overcharge',
     parseMoney('150.5', 'USD') === 15050, `got ${parseMoney('150.5', 'USD')}`)

  // formatMoney is DISPLAY ONLY (symbol, grouping) and must never be fed
  // back into parseMoney -- toAmountInput is the round-trip counterpart.
  ok('formatMoney output does not round-trip through parseMoney',
     parseMoney(formatMoney(150000, 'IDR'), 'IDR') === null)

  // toAmountInput <-> parseMoney round trip, 0-exponent and 2-exponent,
  // several magnitudes including zero.
  for (const [minor, currency] of [
    [0, 'IDR'], [1, 'IDR'], [150000, 'IDR'], [1500000, 'IDR'],
    [0, 'USD'], [5, 'USD'], [15050, 'USD'], [999999, 'USD'],
  ]) {
    const roundTripped = parseMoney(toAmountInput(minor, currency), currency)
    ok(`round trip ${minor} ${currency}`, roundTripped === minor,
       `toAmountInput -> ${toAmountInput(minor, currency)} -> ${roundTripped}`)
  }
  head('5. resolution')
  await pool.query(`
    insert into teams (id, name, organization_id, created_at)
    values ('svc_t1', 'Cabang Satu', $1, now())`, [ORG])
  // No override row is ever inserted for this branch -- it stays that way
  // for the whole section, so it can prove the active check applies even
  // where an override never existed.
  await pool.query(`
    insert into teams (id, name, organization_id, created_at)
    values ('svc_t3', 'Cabang Tanpa Override', $1, now())`, [ORG])
  const priceAt = async (serviceId, teamId) => {
    const { rows } = await pool.query(`
      select price, offered, currency from service_branch_pricing
       where service_id = $1 and team_id = $2`, [serviceId, teamId])
    return rows[0]
  }
  ok('no override resolves to the salon price',
     Number((await priceAt('svc_s1', 'svc_t1')).price) === 150000)

  await pool.query(`
    insert into service_branch_overrides (service_id, team_id, organization_id, price)
    values ('svc_s1', 'svc_t1', $1, 180000)`, [ORG])
  ok('an override resolves to the branch price',
     Number((await priceAt('svc_s1', 'svc_t1')).price) === 180000)

  ok('resolution carries the currency',
     (await priceAt('svc_s1', 'svc_t1')).currency === 'IDR')

  // Every fixture above uses the IDR default, so a hardcoded 'IDR' literal
  // in the view -- or a join that resolved the wrong organization's profile
  // -- would still read IDR and pass the assertion above. Prove the join is
  // per-organization by exercising a second salon on a different currency
  // in the same run.
  await pool.query(`
    insert into services (id, organization_id, name, duration_minutes, price)
    values ('svc_s2', $1, 'Creambath', 45, 90000)`, [ORG2])
  await pool.query(`
    update salon_profiles set currency = 'SGD' where organization_id = $1`, [ORG2])
  ok('a different salon on a different currency resolves its own',
     (await priceAt('svc_s2', 'svc_t2')).currency === 'SGD')
  ok('while the first salon still resolves IDR',
     (await priceAt('svc_s1', 'svc_t1')).currency === 'IDR')

  await pool.query(`
    update service_branch_overrides set offered = false
     where service_id = 'svc_s1' and team_id = 'svc_t1'`)
  ok('offered = false hides it at that branch',
     (await priceAt('svc_s1', 'svc_t1')).offered === false)

  await pool.query(`
    update service_branch_overrides set offered = true, price = null
     where service_id = 'svc_s1' and team_id = 'svc_t1'`)
  await pool.query(`update services set active = false where id = 'svc_s1'`)
  ok('an inactive service is hidden everywhere (branch with an override row)',
     (await priceAt('svc_s1', 'svc_t1')).offered === false)
  // svc_t3 never had an override row at all. An implementation like
  // `case when o.service_id is null then true else s.active and o.offered
  // end` would apply the active check only where an override exists, pass
  // the assertion above, and still show an inactive service as bookable at
  // every branch that never had one -- the common case for most branches.
  ok('an inactive service is hidden everywhere (branch with no override row)',
     (await priceAt('svc_s1', 'svc_t3')).offered === false)
  await pool.query(`update services set active = true where id = 'svc_s1'`)

  // An override whose price EQUALS the salon price is still an override. If
  // the two collapse, a salon-wide price change silently stops reaching that
  // branch -- and nothing visible breaks until someone is charged the old
  // price months later.
  await pool.query(`
    update service_branch_overrides set price = 150000
     where service_id = 'svc_s1' and team_id = 'svc_t1'`)
  await pool.query(`update services set price = 200000 where id = 'svc_s1'`)
  ok('an override equal to the old salon price does NOT follow a salon change',
     Number((await priceAt('svc_s1', 'svc_t1')).price) === 150000,
     String((await priceAt('svc_s1', 'svc_t1')).price))

  await pool.query(`
    update service_branch_overrides set price = null
     where service_id = 'svc_s1' and team_id = 'svc_t1'`)
  ok('while an inheriting branch DOES follow it',
     Number((await priceAt('svc_s1', 'svc_t1')).price) === 200000)

  head('6. the plan cap')
  // Sign in as a fresh salon owner and create through the real action --
  // copied cookie-jar pattern from scripts/auth-check.mjs; ORG itself was
  // inserted with raw SQL in section 3 and has no better-auth user behind
  // it to sign in as. requireQuota('services') is exercised end to end
  // here, not re-implemented as a count query.
  const capCookieOf = (j) => [...j].map(([k, v]) => `${k}=${v}`).join('; ')
  const capDecode = (t) => t.replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  const capSubmitForm = async (j, path, marker, fields = {}) => {
    const page = await fetch(ORIGIN + path, { headers: { cookie: capCookieOf(j) }, redirect: 'manual' })
    const html = await page.text()
    const form = html.split('<form').find((f) => f.includes(marker))
    if (!form) throw new Error(`no form matching ${marker} on ${path} (status ${page.status})`)
    const body = new FormData()
    for (const m of form.slice(0, form.indexOf('</form>')).matchAll(
      /<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?\s*\/>/g)) {
      body.set(capDecode(m[1]), capDecode(m[2] ?? ''))
    }
    for (const [k, v] of Object.entries(fields)) body.set(k, v)
    const r = await fetch(ORIGIN + path, {
      method: 'POST', headers: { cookie: capCookieOf(j) }, body, redirect: 'manual',
    })
    return { status: r.status, location: r.headers.get('location'), html: await r.text() }
  }

  const capOwnerEmail = `cap-owner@${DOMAIN}`
  const capOwner = new Client()
  await capOwner.req('/sign-up/email', { name: 'Svc Cap Owner', email: capOwnerEmail, password: PW })
  await pool.query(`update users set email_verified = true where email = $1`, [capOwnerEmail])
  await capOwner.req('/sign-in/email', { email: capOwnerEmail, password: PW })
  const capOrg = await capOwner.req('/organization/create',
    { name: 'Svc Check Cap', slug: 'svccheck-cap' })
  const capOrgId = capOrg.data?.id
  ok('cap salon created', !!capOrgId, JSON.stringify(capOrg.data))
  await capOwner.req('/organization/set-active', { organizationId: capOrgId })

  // Dynamically read the seeded cap so it can be restored exactly, whatever
  // scripts/seed-plans.mjs currently says free/services is -- do not hardcode 10.
  const { rows: [freeCapRow] } = await pool.query(`
    select l.cap from plan_limits l join plans p on p.id = l.plan_id
     where p.key = 'free' and l.resource = 'services'`)
  const originalFreeServicesCap = freeCapRow.cap

  try {
    // One service, created through the real path, so there is something to
    // both count and later deactivate.
    const first = await capSubmitForm(capOwner.jar, '/services/new', 'name="price"',
      { name: 'Layanan Cap Satu', durationMinutes: '30', price: '50000' })
    ok('a service is created through the real path to seed the cap fixture',
       first.status === 303 && (first.location ?? '').includes('/services'),
       `got ${first.status} ${first.location}`)

    // Cap set to the current active count -- the tenant is now exactly full.
    await pool.query(`
      update plan_limits set cap = 1
       where plan_id = (select id from plans where key = 'free') and resource = 'services'`)

    const refused = await capSubmitForm(capOwner.jar, '/services/new', 'name="price"',
      { name: 'Layanan Cap Dua', durationMinutes: '30', price: '60000' })
    ok('a creation at the cap is refused with the 402 copy',
       refused.status === 200
         && refused.html.includes('Kuota layanan paket Anda sudah tercapai. Upgrade untuk menambah layanan.'),
       `got ${refused.status}`)

    const { rows: [afterRefusal] } = await pool.query(`
      select count(*)::int n from services where organization_id = $1`, [capOrgId])
    ok('and the refused attempt wrote no row', afterRefusal.n === 1, `got ${afterRefusal.n}`)

    // Free the slot with direct SQL -- deactivateServiceAction does not exist
    // yet, so this is fixture setup, not the path under test. The real path
    // below is what proves countResource's active-only semantics.
    await pool.query(`
      update services set active = false
       where organization_id = $1 and name = 'Layanan Cap Satu'`, [capOrgId])

    const afterFree = await capSubmitForm(capOwner.jar, '/services/new', 'name="price"',
      { name: 'Layanan Cap Dua', durationMinutes: '30', price: '60000' })
    ok('the same creation succeeds once a deactivation frees a slot',
       afterFree.status === 303 && (afterFree.location ?? '').includes('/services'),
       `got ${afterFree.status} ${afterFree.location}`)

    const { rows: [afterSuccess] } = await pool.query(`
      select count(*)::int n from services where organization_id = $1`, [capOrgId])
    ok('and the new row exists (one deactivated, one active)',
       afterSuccess.n === 2, `got ${afterSuccess.n}`)
  } finally {
    await pool.query(`
      update plan_limits set cap = $1
       where plan_id = (select id from plans where key = 'free') and resource = 'services'`,
      [originalFreeServicesCap])
  }

  head('7. /services and /services/new')
  // Nothing under lib/ is importable here (lib/service.ts imports './db'
  // without an extension, which plain Node ESM resolution refuses -- proven
  // by trying `await import('../lib/service.ts')` first, same failure shape
  // as lib/branch.ts and lib/staff.ts in the other suites). Driven over HTTP
  // instead, against the real dev server.
  const cookieOf = (j) => [...j].map(([k, v]) => `${k}=${v}`).join('; ')
  const decodeHtml = (t) => t.replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  const getPage = async (j, path) => {
    const r = await fetch(ORIGIN + path, { headers: { cookie: cookieOf(j) }, redirect: 'manual' })
    return { status: r.status, html: await r.text() }
  }
  const submitForm = async (j, path, marker, fields = {}) => {
    const page = await getPage(j, path)
    const form = page.html.split('<form').find((f) => f.includes(marker))
    if (!form) throw new Error(`no form matching ${marker} on ${path} (status ${page.status})`)
    const body = new FormData()
    for (const m of form.slice(0, form.indexOf('</form>')).matchAll(
      /<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?\s*\/>/g)) {
      body.set(decodeHtml(m[1]), decodeHtml(m[2] ?? ''))
    }
    for (const [k, v] of Object.entries(fields)) body.set(k, v)
    const r = await fetch(ORIGIN + path, {
      method: 'POST', headers: { cookie: cookieOf(j) }, body, redirect: 'manual',
    })
    return { status: r.status, location: r.headers.get('location'), html: await r.text() }
  }

  const listOwnerEmail = `list-owner@${DOMAIN}`
  const listOwner = new Client()
  await listOwner.req('/sign-up/email',
    { name: 'Svc List Owner', email: listOwnerEmail, password: PW })
  await pool.query(`update users set email_verified = true where email = $1`, [listOwnerEmail])
  await listOwner.req('/sign-in/email', { email: listOwnerEmail, password: PW })
  const listOrg = await listOwner.req('/organization/create',
    { name: 'Svc Check List', slug: 'svccheck-list' })
  const listOrgId = listOrg.data?.id
  ok('list salon created', !!listOrgId, JSON.stringify(listOrg.data))
  await listOwner.req('/organization/set-active', { organizationId: listOrgId })
  // Business plan, so the branch cap never interferes with the front-desk
  // and stylist fixtures the redirect checks need below.
  await pool.query(`
    update subscriptions set plan_id = (select id from plans where key = 'business')
     where organization_id = $1`, [listOrgId])
  const listBranch = await listOwner.req('/organization/create-team',
    { name: 'Cabang List', organizationId: listOrgId })
  const listBranchId = listBranch.data?.id
  ok('branch created for the redirect fixtures', !!listBranchId, JSON.stringify(listBranch.data))

  // 1. A duplicate name in one salon is refused, case-insensitively (§7.3).
  const created = await submitForm(listOwner.jar, '/services/new', 'name="price"', {
    name: 'Potong Rambut', durationMinutes: '60', price: '150000',
  })
  ok('creating a service redirects to /services',
     created.status === 303 && (created.location ?? '').includes('/services'),
     `got ${created.status} ${created.location}`)

  const dup = await submitForm(listOwner.jar, '/services/new', 'name="price"', {
    name: 'potong rambut', durationMinutes: '45', price: '99000',
  })
  ok('a duplicate name is refused case-insensitively, not redirected',
     dup.status === 200 && dup.html.includes('Layanan dengan nama ini sudah ada.'),
     `got ${dup.status}`)
  const { rows: dupRows } = await pool.query(`
    select count(*)::int n from services
     where organization_id = $1 and lower(name) = 'potong rambut'`, [listOrgId])
  ok('and no second row was created', dupRows[0].n === 1, `got ${dupRows[0].n}`)

  // 2. A front-desk user is redirected away from /services (§5.1/§7.15).
  const listDeskEmail = `list-desk@${DOMAIN}`
  const madeDesk = await listOwner.req('/staff',
    { name: 'Svc List Desk', email: listDeskEmail, password: PW,
      role: 'frontdesk', branchId: listBranchId },
    'POST', APP)
  ok('front desk provisioned for the redirect check',
    madeDesk.status === 201, `got ${madeDesk.status} ${JSON.stringify(madeDesk.data)}`)

  const deskClient = new Client()
  await deskClient.req('/sign-in/email', { email: listDeskEmail, password: PW })
  const deskServicesPage = await fetch(`${ORIGIN}/services`, {
    headers: { cookie: cookieOf(deskClient.jar) }, redirect: 'manual',
  })
  ok('front desk is redirected away from /services',
    deskServicesPage.status === 307
      && (deskServicesPage.headers.get('location') ?? '').includes('/dashboard'),
    `got ${deskServicesPage.status} ${deskServicesPage.headers.get('location')}`)

  // 3. A stylist likewise (§7.15).
  const listStylistEmail = `list-stylist@${DOMAIN}`
  const madeStylist = await listOwner.req('/staff',
    { name: 'Svc List Stylist', email: listStylistEmail, password: PW,
      role: 'stylist', branchId: listBranchId },
    'POST', APP)
  ok('stylist provisioned for the redirect check',
    madeStylist.status === 201, `got ${madeStylist.status} ${JSON.stringify(madeStylist.data)}`)

  const stylistClient = new Client()
  await stylistClient.req('/sign-in/email', { email: listStylistEmail, password: PW })
  const stylistServicesPage = await fetch(`${ORIGIN}/services`, {
    headers: { cookie: cookieOf(stylistClient.jar) }, redirect: 'manual',
  })
  ok('a stylist is likewise redirected away from /services',
    stylistServicesPage.status === 307
      && (stylistServicesPage.headers.get('location') ?? '').includes('/dashboard'),
    `got ${stylistServicesPage.status} ${stylistServicesPage.headers.get('location')}`)

  // 4. Another salon's service id reads as not-found and leaks no name
  // (§7.16). A COMPLETE fixture -- a real category AND a real service in
  // ORG2 (section 3's fixture salon) -- not a bare row missing something the
  // list query joins on. An incomplete fixture is exactly how three earlier
  // assertions in this project passed for the wrong reason.
  await pool.query(`
    insert into service_categories (id, organization_id, name)
    values ('svc_cat2', $1, 'Perawatan Rambut')`, [ORG2])
  await pool.query(`
    insert into services (id, organization_id, category_id, name, duration_minutes, price)
    values ('svc_cross', $1, 'svc_cat2', 'Rebonding Salon Lain', 120, 500000)`, [ORG2])

  const crossPage = await fetch(`${ORIGIN}/services/svc_cross`, {
    headers: { cookie: cookieOf(listOwner.jar) }, redirect: 'manual',
  })
  const crossHtml = await crossPage.text()
  ok('another salon\'s service id is not a 200 with data',
    crossPage.status !== 200, `got ${crossPage.status}`)
  ok('and its name never appears in that response', !crossHtml.includes('Rebonding Salon Lain'))

  // The same claim, proven where it actually has teeth: listServices() is
  // what the /services LIST renders for listOwner's own salon, so if its
  // organization_id filter were ever dropped, ORG2's service and category
  // would leak straight into listOwner's own catalogue -- not merely fail to
  // resolve at a URL nothing points at yet.
  const ownListPage = await fetch(`${ORIGIN}/services`, {
    headers: { cookie: cookieOf(listOwner.jar) }, redirect: 'manual',
  })
  const ownListHtml = await ownListPage.text()
  ok('the other salon\'s service never leaks into this salon\'s own list',
    !ownListHtml.includes('Rebonding Salon Lain') && !ownListHtml.includes('Perawatan Rambut'))
} finally {
  await pool.end()
}

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m`)
process.exit(fail ? 1 : 0)
