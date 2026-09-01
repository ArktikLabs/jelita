/**
 * Services catalogue checks. No framework on purpose.
 *   pnpm service:check      (dev server must be running for later sections)
 */
import { Pool } from 'pg'
import { PLANS } from './seed-plans.mjs'

// Free's services cap comes from the seed, not the live plan_limits row --
// section 6 mutates that row, and a killed run must never launder a
// corrupted value forward as if it were the source of truth.
const FREE = PLANS.find((p) => p.key === 'free')

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
  // Section 6 temporarily repoints free's services cap to prove the cap
  // enforces. Restoring it unconditionally here -- not only in that
  // section's own `finally` -- means a run killed mid-mutation (this
  // fixture has been killed by machine sleep before) cannot leave the
  // shared cap corrupted for every free-tier organization going forward:
  // the very next run repairs it before doing anything else, from the
  // seed (a source a crashed run cannot itself have corrupted), not from
  // the live row.
  await pool.query(`
    update plan_limits set cap = $1
     where plan_id = (select id from plans where key = 'free') and resource = 'services'`,
    [FREE.caps.services])
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

  // Shared over HTTP against the real dev server by sections 6 and 7 --
  // one copy so an extended HTML-entity decode list (or any other drift)
  // cannot silently diverge between them and mis-parse hidden form fields
  // in only one section.
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

  head('6. the plan cap')
  // Sign in as a fresh salon owner and create through the real action --
  // copied cookie-jar pattern from scripts/auth-check.mjs; ORG itself was
  // inserted with raw SQL in section 3 and has no better-auth user behind
  // it to sign in as. requireQuota('services') is exercised end to end
  // here, not re-implemented as a count query.
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

  try {
    // One service, created through the real path, so there is something to
    // both count and later deactivate.
    const first = await submitForm(capOwner.jar, '/services/new', 'name="price"',
      { name: 'Layanan Cap Satu', durationMinutes: '30', price: '50000' })
    ok('a service is created through the real path to seed the cap fixture',
       first.status === 303 && (first.location ?? '').includes('/services'),
       `got ${first.status} ${first.location}`)

    // Cap set to the current active count -- the tenant is now exactly full.
    await pool.query(`
      update plan_limits set cap = 1
       where plan_id = (select id from plans where key = 'free') and resource = 'services'`)

    const refused = await submitForm(capOwner.jar, '/services/new', 'name="price"',
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

    const afterFree = await submitForm(capOwner.jar, '/services/new', 'name="price"',
      { name: 'Layanan Cap Dua', durationMinutes: '30', price: '60000' })
    ok('the same creation succeeds once a deactivation frees a slot',
       afterFree.status === 303 && (afterFree.location ?? '').includes('/services'),
       `got ${afterFree.status} ${afterFree.location}`)

    const { rows: [afterSuccess] } = await pool.query(`
      select count(*)::int n from services where organization_id = $1`, [capOrgId])
    ok('and the new row exists (one deactivated, one active)',
       afterSuccess.n === 2, `got ${afterSuccess.n}`)
  } finally {
    // Restored from the seed (FREE.caps.services), same source section 0
    // uses -- not from a live row this very block just mutated, and that a
    // crash right after the mutation could otherwise have left corrupted.
    await pool.query(`
      update plan_limits set cap = $1
       where plan_id = (select id from plans where key = 'free') and resource = 'services'`,
      [FREE.caps.services])
  }

  head('7. /services and /services/new')
  // Nothing under lib/ is importable here (lib/service.ts imports './db'
  // without an extension, which plain Node ESM resolution refuses -- proven
  // by trying `await import('../lib/service.ts')` first, same failure shape
  // as lib/branch.ts and lib/staff.ts in the other suites). Driven over HTTP
  // instead, against the real dev server, via the cookieOf/getPage/submitForm
  // helpers shared with section 6 above.
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

  head('8. the detail screen and per-branch overrides')
  // A fresh salon, business plan so the branch cap (1 on free) never
  // interferes with the two-branch fixture this section needs.
  const ovrOwnerEmail = `ovr-owner@${DOMAIN}`
  const ovrOwner = new Client()
  await ovrOwner.req('/sign-up/email',
    { name: 'Svc Ovr Owner', email: ovrOwnerEmail, password: PW })
  await pool.query(`update users set email_verified = true where email = $1`, [ovrOwnerEmail])
  await ovrOwner.req('/sign-in/email', { email: ovrOwnerEmail, password: PW })
  const ovrOrg = await ovrOwner.req('/organization/create',
    { name: 'Svc Check Overrides', slug: 'svccheck-overrides' })
  const ovrOrgId = ovrOrg.data?.id
  ok('overrides salon created', !!ovrOrgId, JSON.stringify(ovrOrg.data))
  await ovrOwner.req('/organization/set-active', { organizationId: ovrOrgId })
  await pool.query(`
    update subscriptions set plan_id = (select id from plans where key = 'business')
     where organization_id = $1`, [ovrOrgId])

  const branchA = await ovrOwner.req('/organization/create-team',
    { name: 'Cabang Utama Ovr', organizationId: ovrOrgId })
  const branchB = await ovrOwner.req('/organization/create-team',
    { name: 'Cabang Kedua Ovr', organizationId: ovrOrgId })
  const teamA = branchA.data?.id
  const teamB = branchB.data?.id
  ok('two branches created for the overrides fixture', !!teamA && !!teamB,
     JSON.stringify([branchA.data, branchB.data]))

  const created8 = await submitForm(ovrOwner.jar, '/services/new', 'name="price"',
    { name: 'Creambath Premium', durationMinutes: '40', price: '100000' })
  ok('service created for the overrides fixture',
     created8.status === 303 && (created8.location ?? '').includes('/services'),
     `got ${created8.status} ${created8.location}`)
  const { rows: [ovrService] } = await pool.query(`
    select id from services where organization_id = $1 and name = 'Creambath Premium'`, [ovrOrgId])
  const ovrServiceId = ovrService?.id
  ok('overrides fixture service id resolved', !!ovrServiceId)
  const ovrPath = `/services/${ovrServiceId}`

  // 1. Set branch A's price to the SAME number as the current salon price
  // (100000). Still an override -- so changing the salon price afterwards
  // must NOT move branch A. Both branches start offered (checkboxes default
  // checked, so 'on' is what a real submit of the unedited row would send).
  const step1 = await submitForm(ovrOwner.jar, ovrPath, 'name="serviceId"', {
    [`price-${teamA}`]: '100000', [`offered-${teamA}`]: 'on',
    [`price-${teamB}`]: '', [`offered-${teamB}`]: 'on',
  })
  ok('setting branch A to the salon price is accepted',
     step1.status === 200 && step1.html.includes('Harga per cabang diperbarui.'),
     `got ${step1.status}`)

  const updatePrice = (price) => submitForm(ovrOwner.jar, ovrPath, 'name="price"',
    { name: 'Creambath Premium', durationMinutes: '40', price: String(price) })

  const afterRaise = await updatePrice(130000)
  ok('the salon price change itself is accepted',
     afterRaise.status === 200 && afterRaise.html.includes('Layanan diperbarui.'),
     `got ${afterRaise.status}`)
  ok('branch A stays on its own number after the salon price changes (spec 2.1, via the UI)',
     Number((await priceAt(ovrServiceId, teamA)).price) === 100000,
     String((await priceAt(ovrServiceId, teamA)).price))
  ok('branch B, still inheriting, follows the new salon price',
     Number((await priceAt(ovrServiceId, teamB)).price) === 130000,
     String((await priceAt(ovrServiceId, teamB)).price))

  // 2. Clear branch A's field -- it returns to inheriting, and the NEXT
  // salon change (not just the current price) must reach it too.
  const step2 = await submitForm(ovrOwner.jar, ovrPath, 'name="serviceId"', {
    [`price-${teamA}`]: '', [`offered-${teamA}`]: 'on',
    [`price-${teamB}`]: '', [`offered-${teamB}`]: 'on',
  })
  ok('clearing branch A\'s override is accepted',
     step2.status === 200 && step2.html.includes('Harga per cabang diperbarui.'),
     `got ${step2.status}`)
  ok('clearing the field returns branch A to inheriting the current salon price',
     Number((await priceAt(ovrServiceId, teamA)).price) === 130000,
     String((await priceAt(ovrServiceId, teamA)).price))

  const afterSecondRaise = await updatePrice(150000)
  ok('a second salon price change is accepted',
     afterSecondRaise.status === 200 && afterSecondRaise.html.includes('Layanan diperbarui.'),
     `got ${afterSecondRaise.status}`)
  ok('an inheriting branch A follows the NEXT salon change too',
     Number((await priceAt(ovrServiceId, teamA)).price) === 150000,
     String((await priceAt(ovrServiceId, teamA)).price))

  // 3. Toggle "offered" off at branch B only -- branch A's price and offered
  // state must be untouched by the same submit.
  const step3 = await submitForm(ovrOwner.jar, ovrPath, 'name="serviceId"', {
    [`price-${teamA}`]: '', [`offered-${teamA}`]: 'on',
    [`price-${teamB}`]: '', // offered-teamB omitted -- an unchecked checkbox submits nothing
  })
  ok('toggling branch B\'s offered flag is accepted',
     step3.status === 200 && step3.html.includes('Harga per cabang diperbarui.'),
     `got ${step3.status}`)
  ok('branch B is hidden after the toggle',
     (await priceAt(ovrServiceId, teamB)).offered === false)
  ok('branch A is still offered, untouched by the same submit',
     (await priceAt(ovrServiceId, teamA)).offered === true)
  ok('and branch A\'s price is likewise untouched',
     Number((await priceAt(ovrServiceId, teamA)).price) === 150000,
     String((await priceAt(ovrServiceId, teamA)).price))

  // 4. An override naming another salon's branch (ORG2's svc_t2, fixture
  // from section 3) is refused and writes nothing -- the action only ever
  // iterates this org's OWN branches (listBranches(organizationId)), so a
  // price-<foreignTeamId> field is never even read, let alone written.
  const step4 = await submitForm(ovrOwner.jar, ovrPath, 'name="serviceId"', {
    [`price-${teamA}`]: '', [`offered-${teamA}`]: 'on',
    [`price-${teamB}`]: '',
    'price-svc_t2': '999000', 'offered-svc_t2': 'on',
  })
  ok('a submit naming a foreign branch does not error out',
     step4.status === 200 && step4.html.includes('Harga per cabang diperbarui.'),
     `got ${step4.status}`)
  const { rows: [foreignRow] } = await pool.query(`
    select count(*)::int n from service_branch_overrides
     where service_id = $1 and team_id = 'svc_t2'`, [ovrServiceId])
  ok('no service_branch_overrides row exists for the foreign (service, team) pair afterwards',
     foreignRow.n === 0, `got ${foreignRow.n}`)

  // 5. Reactivating a service AT the cap returns 402 (spec 7.9, moved here
  // from the cap task because reactivateServiceAction did not exist yet).
  // Proven the real way: fill the cap, deactivate, confirm the refusal, and
  // confirm the service is STILL inactive afterwards.
  const reactOwnerEmail = `react-owner@${DOMAIN}`
  const reactOwner = new Client()
  await reactOwner.req('/sign-up/email',
    { name: 'Svc React Owner', email: reactOwnerEmail, password: PW })
  await pool.query(`update users set email_verified = true where email = $1`, [reactOwnerEmail])
  await reactOwner.req('/sign-in/email', { email: reactOwnerEmail, password: PW })
  const reactOrg = await reactOwner.req('/organization/create',
    { name: 'Svc Check Reactivate', slug: 'svccheck-reactivate' })
  const reactOrgId = reactOrg.data?.id
  ok('reactivate salon created', !!reactOrgId, JSON.stringify(reactOrg.data))
  await reactOwner.req('/organization/set-active', { organizationId: reactOrgId })

  const reactCreated = await submitForm(reactOwner.jar, '/services/new', 'name="price"',
    { name: 'Layanan Reaktivasi', durationMinutes: '30', price: '50000' })
  ok('reactivate fixture service created',
     reactCreated.status === 303 && (reactCreated.location ?? '').includes('/services'),
     `got ${reactCreated.status} ${reactCreated.location}`)
  const { rows: [reactService] } = await pool.query(`
    select id from services where organization_id = $1 and name = 'Layanan Reaktivasi'`, [reactOrgId])
  const reactServiceId = reactService?.id
  ok('reactivate fixture service id resolved', !!reactServiceId)

  try {
    // A second, active filler service inserted directly -- fixture setup,
    // not the path under test (creation is already covered in section 6).
    // Once the cap is pinned to 1, this filler alone fills it, so the target
    // service being deactivated/reactivated is what decides the outcome.
    await pool.query(`
      insert into services (id, organization_id, name, duration_minutes, price)
      values ('svc_react_filler', $1, 'Layanan Pengisi', 30, 40000)`, [reactOrgId])
    await pool.query(`
      update plan_limits set cap = 1
       where plan_id = (select id from plans where key = 'free') and resource = 'services'`)

    // Asserted by the button label flipping, not a "done" alert: the status
    // form's action ref is `active ? deactivate... : reactivate...`, and a
    // successful flip re-renders with a DIFFERENT action bound to the same
    // useActionState call, so React's progressive-enhancement replay cannot
    // reattach the old submission's result to it. branch-check.mjs's own
    // BranchStatusForm assertions hit the identical shape and use the same
    // button-flip check for exactly this reason -- see 'Aktifkan cabang'
    // there.
    const deactivated = await submitForm(reactOwner.jar, `/services/${reactServiceId}`,
      'Nonaktifkan layanan</button>')
    ok('deactivating the target service through the real action succeeds',
       deactivated.status === 200
         && deactivated.html.includes('Aktifkan layanan</button>')
         && !deactivated.html.includes('Nonaktifkan layanan</button>'),
       `got ${deactivated.status}`)
    const { rows: [afterDeactivate] } = await pool.query(`
      select active from services where id = $1`, [reactServiceId])
    ok('and it is inactive', afterDeactivate.active === false)

    // The filler alone (still active) now equals the cap, so reactivating
    // the target must be refused. This one fails WITHOUT flipping `active`,
    // so the ternary's action ref does not change and the error DOES replay
    // -- unlike the success case above.
    const reactivated = await submitForm(reactOwner.jar, `/services/${reactServiceId}`,
      'Aktifkan layanan</button>')
    ok('reactivating at the cap is refused with the 402 copy',
       reactivated.status === 200
         && reactivated.html.includes('Kuota layanan paket Anda sudah tercapai. Upgrade untuk menambah layanan.'),
       `got ${reactivated.status}`)
    const { rows: [afterRefusal] } = await pool.query(`
      select active from services where id = $1`, [reactServiceId])
    ok('and it is still inactive after the refusal', afterRefusal.active === false)
  } finally {
    // Restored from the seed (FREE.caps.services), not the live row -- same
    // rule as section 6's finally, for the same laundering reason.
    await pool.query(`
      update plan_limits set cap = $1
       where plan_id = (select id from plans where key = 'free') and resource = 'services'`,
      [FREE.caps.services])
  }

  head('9. who performs a service')
  // Free plan is enough: 1 branch, and owner + admin + stylist is exactly 3
  // staff (the free cap) -- no plan upgrade needed for this fixture.
  const perfOwnerEmail = `perf-owner@${DOMAIN}`
  const perfOwner = new Client()
  await perfOwner.req('/sign-up/email',
    { name: 'Svc Perf Owner', email: perfOwnerEmail, password: PW })
  await pool.query(`update users set email_verified = true where email = $1`, [perfOwnerEmail])
  await perfOwner.req('/sign-in/email', { email: perfOwnerEmail, password: PW })
  const perfOrg = await perfOwner.req('/organization/create',
    { name: 'Svc Check Performers', slug: 'svccheck-performers' })
  const perfOrgId = perfOrg.data?.id
  ok('performers salon created', !!perfOrgId, JSON.stringify(perfOrg.data))
  await perfOwner.req('/organization/set-active', { organizationId: perfOrgId })

  // The free plan's branch cap is 1, and better-auth already auto-creates a
  // default team when the organization itself is created (lib/auth.ts's
  // organizationHooks.beforeCreateTeam note) -- that default team IS the
  // fixture's one branch, so a second create-team call would exceed the cap
  // for no reason.
  const { rows: [perfBranchRow] } = await pool.query(`
    select id from teams where organization_id = $1 limit 1`, [perfOrgId])
  const perfBranchId = perfBranchRow?.id
  ok('the default branch created with the org resolved', !!perfBranchId)

  const perfStylistEmail = `perf-stylist@${DOMAIN}`
  const madePerfStylist = await perfOwner.req('/staff',
    { name: 'Svc Perf Stylist', email: perfStylistEmail, password: PW,
      role: 'stylist', branchId: perfBranchId },
    'POST', APP)
  ok('stylist with a branch provisioned', madePerfStylist.status === 201,
     `got ${madePerfStylist.status} ${JSON.stringify(madePerfStylist.data)}`)
  const perfStylistId = madePerfStylist.data?.user?.id

  // An admin, deliberately with NO branchId -- §8's known gap. team_id stays
  // null, so this is the "not eligible" fixture for assertion 2.
  const perfAdminEmail = `perf-admin@${DOMAIN}`
  const madePerfAdmin = await perfOwner.req('/staff',
    { name: 'Svc Perf Admin', email: perfAdminEmail, password: PW, role: 'admin' },
    'POST', APP)
  ok('admin with no branch provisioned', madePerfAdmin.status === 201,
     `got ${madePerfAdmin.status} ${JSON.stringify(madePerfAdmin.data)}`)
  const perfAdminId = madePerfAdmin.data?.user?.id

  const perfCreated = await submitForm(perfOwner.jar, '/services/new', 'name="price"',
    { name: 'Creambath Performer', durationMinutes: '30', price: '80000' })
  ok('service created for the performers fixture',
     perfCreated.status === 303 && (perfCreated.location ?? '').includes('/services'),
     `got ${perfCreated.status} ${perfCreated.location}`)
  const { rows: [perfService] } = await pool.query(`
    select id from services where organization_id = $1 and name = 'Creambath Performer'`,
    [perfOrgId])
  const perfServiceId = perfService?.id
  ok('performers fixture service id resolved', !!perfServiceId)
  const perfPath = `/services/${perfServiceId}`

  // 1. The candidate list, as actually rendered: the eligible stylist is
  // offered a checkbox; the branchless admin is not (spec §8's gap proven on
  // the rendered page, not just the query).
  const perfPage = await getPage(perfOwner.jar, perfPath)
  ok('the eligible stylist is offered as a performer candidate',
     perfPage.html.includes(`name="performer-${perfStylistId}"`))
  ok('a staff member with no branch assignment is NOT offered as a candidate (spec §8)',
     !perfPage.html.includes(`name="performer-${perfAdminId}"`))

  // 2. Checking the stylist creates a service_staff row.
  const perfCheck = await submitForm(perfOwner.jar, perfPath, 'name="performer-',
    { [`performer-${perfStylistId}`]: 'on' })
  ok('checking the stylist is accepted',
     perfCheck.status === 200 && perfCheck.html.includes('Staf layanan diperbarui.'),
     `got ${perfCheck.status}`)
  const { rows: [linkedRow] } = await pool.query(`
    select count(*)::int n from service_staff
     where service_id = $1 and user_id = $2 and organization_id = $3`,
    [perfServiceId, perfStylistId, perfOrgId])
  ok('a service_staff row now exists for the checked stylist', linkedRow.n === 1)

  // 3. Unchecking (submitting the set with the field simply omitted, same as
  // an unchecked checkbox) removes the row.
  const perfUncheck = await submitForm(perfOwner.jar, perfPath, 'name="performer-', {})
  ok('unchecking the stylist is accepted',
     perfUncheck.status === 200 && perfUncheck.html.includes('Staf layanan diperbarui.'),
     `got ${perfUncheck.status}`)
  const { rows: [unlinkedRow] } = await pool.query(`
    select count(*)::int n from service_staff
     where service_id = $1 and user_id = $2 and organization_id = $3`,
    [perfServiceId, perfStylistId, perfOrgId])
  ok('the row is gone after unchecking', unlinkedRow.n === 0)

  // 4. A service_staff row naming another salon's user is refused BY THE
  // DATABASE (spec §7.14) -- attempt the insert directly, not through the
  // action, and require it to fail. svc_u2 (section 3) belongs to ORG2's
  // staff_profiles, not perfOrgId's, so (svc_u2, perfOrgId) cannot satisfy
  // service_staff_person_fk even though perfServiceId itself is a real,
  // owned service.
  let crossTenantRefused = false
  try {
    await pool.query(`
      insert into service_staff (service_id, user_id, organization_id)
      values ($1, 'svc_u2', $2)`, [perfServiceId, perfOrgId])
  } catch { crossTenantRefused = true }
  ok('a service_staff row naming another salon\'s user is refused by the database',
     crossTenantRefused)
  head('10. currency at onboarding, and locking it')
  // 1. A salon created through onboarding with SGD has SGD in salon_profiles.
  // The trigger already seeded this row defaulting to IDR -- createSalonAction
  // must UPDATE it, not leave the default standing.
  const curOwnerEmail = `cur-owner@${DOMAIN}`
  const curOwner = new Client()
  await curOwner.req('/sign-up/email',
    { name: 'Svc Currency Owner', email: curOwnerEmail, password: PW })
  await pool.query(`update users set email_verified = true where email = $1`, [curOwnerEmail])
  await curOwner.req('/sign-in/email', { email: curOwnerEmail, password: PW })

  const onboarded = await submitForm(curOwner.jar, '/onboarding', 'name="slug"',
    { name: 'Svc Check Currency', slug: 'svccheck-currency', currency: 'SGD' })
  ok('onboarding with SGD redirects to /dashboard',
     onboarded.status === 303 && (onboarded.location ?? '').includes('/dashboard'),
     `got ${onboarded.status} ${onboarded.location}`)

  const { rows: [curOrg] } = await pool.query(
    `select id from organizations where slug = 'svccheck-currency'`)
  const curOrgId = curOrg?.id
  ok('currency salon created', !!curOrgId)
  const currencyOf = async () => {
    const { rows: [row] } = await pool.query(
      `select currency from salon_profiles where organization_id = $1`, [curOrgId])
    return row?.currency
  }
  ok('the seeded profile now holds the chosen currency, SGD, not the trigger\'s IDR default',
     (await currencyOf()) === 'SGD', `got ${await currencyOf()}`)

  // The currency card only renders a FORM while the catalogue is empty (once
  // a service exists it collapses to a read-only line) -- captured once here
  // so assertion 3 below can still submit it after that service exists. That
  // is not a workaround: it is exactly the shape of the race the guard
  // exists for -- a browser tab left open on the empty-catalogue page,
  // submitted after a service was created in another tab. A fresh GET always
  // encodes the same initial ({}) useActionState seed, so this is no
  // different from re-fetching the form each time, the way submitForm does.
  const currencyFormPage = await getPage(curOwner.jar, '/services')
  const currencyFormChunk = currencyFormPage.html.split('<form')
    .find((f) => f.includes('name="currency"'))
  if (!currencyFormChunk) throw new Error('no currency form found while the catalogue is empty')
  const currencyHidden = [...currencyFormChunk.slice(0, currencyFormChunk.indexOf('</form>')).matchAll(
    /<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?\s*\/>/g)]
  const submitCurrency = async (currency) => {
    const body = new FormData()
    for (const [, k, v] of currencyHidden) body.set(decodeHtml(k), decodeHtml(v ?? ''))
    body.set('currency', currency)
    const r = await fetch(`${ORIGIN}/services`, {
      method: 'POST', headers: { cookie: cookieOf(curOwner.jar) }, body, redirect: 'manual',
    })
    return { status: r.status, location: r.headers.get('location'), html: await r.text() }
  }

  // 2. Currency is changeable while the catalogue is empty.
  const changed = await submitCurrency('MYR')
  ok('changing currency while the catalogue is empty is accepted',
     changed.status === 200 && changed.html.includes('Mata uang disimpan.'),
     `got ${changed.status}`)
  ok('and the stored currency reflects the change',
     (await currencyOf()) === 'MYR', `got ${await currencyOf()}`)

  // An unrecognised code is a form error, never a stored value -- isCurrencyCode
  // must refuse it before the guarded UPDATE ever runs.
  const bogus = await submitCurrency('ZZZ')
  ok('an unrecognised currency code is refused',
     bogus.status === 200 && bogus.html.includes('Mata uang tidak dikenali.'),
     `got ${bogus.status}`)
  ok('and the stored currency is unchanged by the refused attempt',
     (await currencyOf()) === 'MYR', `got ${await currencyOf()}`)

  // 3. Once a service exists, the change is refused with the 409 copy, and
  // the stored currency is unchanged -- spec 2.6, the whole point of this task.
  const curService = await submitForm(curOwner.jar, '/services/new', 'name="price"',
    { name: 'Layanan Mata Uang', durationMinutes: '30', price: '50' })
  ok('a service is created to lock the currency',
     curService.status === 303 && (curService.location ?? '').includes('/services'),
     `got ${curService.status} ${curService.location}`)

  const refusedLocked = await submitCurrency('IDR')
  ok('changing currency once a service exists is refused with the 409 copy',
     refusedLocked.status === 200
       && refusedLocked.html.includes('Mata uang tidak dapat diubah setelah ada layanan berharga.'),
     `got ${refusedLocked.status}`)
  ok('and the stored currency is unchanged',
     (await currencyOf()) === 'MYR', `got ${await currencyOf()}`)
  ok('the /services page now renders the read-only line, not the form',
     refusedLocked.html.includes('sudah ada layanan berharga'))

  // 4. A price entered in a 2-exponent salon (SGD) stores the right minor
  // units and renders back identically -- the 100x check. A fresh salon, so
  // this is not entangled with curOrgId's currency changes above.
  const sgdOwnerEmail = `sgd-owner@${DOMAIN}`
  const sgdOwner = new Client()
  await sgdOwner.req('/sign-up/email',
    { name: 'Svc SGD Owner', email: sgdOwnerEmail, password: PW })
  await pool.query(`update users set email_verified = true where email = $1`, [sgdOwnerEmail])
  await sgdOwner.req('/sign-in/email', { email: sgdOwnerEmail, password: PW })

  const sgdOnboarded = await submitForm(sgdOwner.jar, '/onboarding', 'name="slug"',
    { name: 'Svc Check SGD', slug: 'svccheck-sgd', currency: 'SGD' })
  ok('SGD onboarding salon created',
     sgdOnboarded.status === 303 && (sgdOnboarded.location ?? '').includes('/dashboard'),
     `got ${sgdOnboarded.status} ${sgdOnboarded.location}`)
  const { rows: [sgdOrg] } = await pool.query(
    `select id from organizations where slug = 'svccheck-sgd'`)
  const sgdOrgId = sgdOrg?.id
  ok('SGD salon id resolved', !!sgdOrgId)

  const sgdService = await submitForm(sgdOwner.jar, '/services/new', 'name="price"',
    { name: 'Layanan SGD', durationMinutes: '30', price: '250.50' })
  ok('the SGD-priced service is created',
     sgdService.status === 303 && (sgdService.location ?? '').includes('/services'),
     `got ${sgdService.status} ${sgdService.location}`)

  const { rows: [sgdRow] } = await pool.query(
    `select price from services where organization_id = $1 and name = 'Layanan SGD'`, [sgdOrgId])
  ok('250.50 SGD is stored as 25050 minor units -- not 250 (truncated) or 2505050 (10x)',
     Number(sgdRow?.price) === 25050, `got ${sgdRow?.price}`)

  const sgdListPage = await getPage(sgdOwner.jar, '/services')
  ok('the list page renders the stored minor units back through formatMoney identically',
     decodeHtml(sgdListPage.html).includes(formatMoney(25050, 'SGD')),
     formatMoney(25050, 'SGD'))

  // 5. Concurrency: a service creation and a currency change fired at the
  // SAME instant against a fresh, empty-catalogue salon must never BOTH
  // succeed. Assertion 3 above (sequential: create, then change) already
  // passes without any locking at all -- it proves nothing about the race.
  // Fired together via Promise.all, the way this was actually reproduced:
  // 15/15 trials corrupted (service created AND currency flipped to SGD,
  // Rp 50.000 silently reading as $500.00) before createServiceAction and
  // setCurrencyAction both took `for update` on the same salon_profiles row.
  const raceTrial = async (n) => {
    const email = `race-${n}@${DOMAIN}`
    const owner = new Client()
    await owner.req('/sign-up/email', { name: `Race Owner ${n}`, email, password: PW })
    await pool.query(`update users set email_verified = true where email = $1`, [email])
    await owner.req('/sign-in/email', { email, password: PW })
    await submitForm(owner.jar, '/onboarding', 'name="slug"',
      { name: `Race Salon ${n}`, slug: `svccheck-race-${n}`, currency: 'IDR' })
    const { rows: [org] } = await pool.query(
      `select id from organizations where slug = $1`, [`svccheck-race-${n}`])
    const orgId = org.id

    // Capture both forms' hidden action fields BEFORE firing either POST --
    // this is what the race actually looks like: two requests against the
    // same empty-catalogue state, submitted at the same instant.
    const captureHidden = async (path, marker) => {
      const page = await getPage(owner.jar, path)
      const chunk = page.html.split('<form').find((f) => f.includes(marker))
      if (!chunk) throw new Error(`no form ${marker} on ${path}`)
      return [...chunk.slice(0, chunk.indexOf('</form>')).matchAll(
        /<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?\s*\/>/g)]
    }
    const svcHidden = await captureHidden('/services/new', 'name="price"')
    const curHidden = await captureHidden('/services', 'name="currency"')

    const svcBody = new FormData()
    for (const [, k, v] of svcHidden) svcBody.set(decodeHtml(k), decodeHtml(v ?? ''))
    svcBody.set('name', 'Layanan Race')
    svcBody.set('durationMinutes', '30')
    svcBody.set('price', '50000')

    const curBody = new FormData()
    for (const [, k, v] of curHidden) curBody.set(decodeHtml(k), decodeHtml(v ?? ''))
    curBody.set('currency', 'SGD')

    await Promise.all([
      fetch(`${ORIGIN}/services/new`,
        { method: 'POST', headers: { cookie: cookieOf(owner.jar) }, body: svcBody, redirect: 'manual' }),
      fetch(`${ORIGIN}/services`,
        { method: 'POST', headers: { cookie: cookieOf(owner.jar) }, body: curBody, redirect: 'manual' }),
    ])

    const { rows: [profile] } = await pool.query(
      `select currency from salon_profiles where organization_id = $1`, [orgId])
    const { rows: [svcCount] } = await pool.query(
      `select count(*)::int n from services where organization_id = $1`, [orgId])
    return { serviceExists: svcCount.n > 0, currency: profile.currency }
  }

  const RACE_TRIALS = 15
  let raceCorrupted = 0
  for (let n = 0; n < RACE_TRIALS; n++) {
    const { serviceExists, currency } = await raceTrial(n)
    // The corrupted state, precisely: a service exists (created) AND the
    // currency actually changed to SGD (changed) -- both writes landing,
    // reinterpreting the just-created service's price by 100x forever after.
    if (serviceExists && currency === 'SGD') raceCorrupted++
  }
  ok(`a concurrent service-creation + currency-change race never lets both succeed (${RACE_TRIALS} trials)`,
     raceCorrupted === 0, `${raceCorrupted}/${RACE_TRIALS} corrupted`)
} finally {
  await pool.end()
}

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m`)
process.exit(fail ? 1 : 0)
