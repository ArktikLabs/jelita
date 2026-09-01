/**
 * Customer checks. No framework on purpose.
 *   pnpm customer:check      (dev server must be running for later sections)
 */
import { Pool } from 'pg'

let pass = 0, fail = 0
const ok = (n, c, d) => (c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${n}`))
                           : (fail++, console.log(`  \x1b[31m✗\x1b[0m ${n}  ${d ?? ''}`)))
const head = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`)

const pool = new Pool({ connectionString: process.env.DIRECT_URL })
const ORIGIN = process.env.BETTER_AUTH_URL
const BASE = `${ORIGIN}/api/auth`
const PW = 'demo12345'

// Cookie-jar client, copied from scripts/service-check.mjs: email verification
// is on, so a freshly signed-up user has no session until verified.
class Client {
  constructor() { this.jar = new Map() }
  async req(path, body, method = 'POST', base = BASE) {
    const headers = { 'content-type': 'application/json', origin: ORIGIN }
    if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ')
    const res = await fetch(base + path, {
      method, headers, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
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
  cookie() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ') }
}

const page = (path, cookie) => fetch(ORIGIN + path, {
  headers: cookie ? { cookie } : {}, redirect: 'manual',
}).then(async (r) => ({ status: r.status, location: r.headers.get('location'), html: await r.text() }))
const ORG = 'custcheck_org'
const ORG2 = 'custcheck_org2'
const DOMAIN = 'custcheck.local'

try {
  head('0. reset test fixtures')
  // Unconditional, at the START of every run: later sections reuse fixtures
  // created by earlier ones, so cleanup never happens mid-run (a crash would
  // poison the next run) or at a section's end (a later section needs the row).
  await pool.query(`delete from organizations where slug like 'custcheck%'`)
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`])
  ok('cleared', true)

  head('1. schema')
  const { rows: idx } = await pool.query(`
    select indexname from pg_indexes where tablename = 'customers'`)
  ok('the partial phone index exists',
     idx.some((r) => r.indexname === 'customers_org_phone_key'))
  const { rows: [rls] } = await pool.query(`
    select relrowsecurity from pg_class where relname = 'customers'`)
  ok('RLS enabled', rls.relrowsecurity === true)

  head('2. normalisation')
  const { normalizePhone } = await import('../lib/phone.ts')
  const spellings = ['0812345678', '+62 812 345 678', '62812345678', '0812-3456-78']
  ok('every spelling of one number normalises alike',
     new Set(spellings.map(normalizePhone)).size === 1,
     JSON.stringify(spellings.map(normalizePhone)))
  ok('a mistyped 62-plus-0 prefix folds too', normalizePhone('620812345678') === '62812345678')
  ok('input with no digits is refused', normalizePhone('abc') === null && normalizePhone('') === null)

  head('3. one customer per number per salon')
  await pool.query(`
    insert into organizations (id, name, slug, created_at)
    values ($1, 'Cust Check', 'custcheck', now()), ($2, 'Cust Check 2', 'custcheck2', now())`,
    [ORG, ORG2])
  const add = (id, org, name, phone, key) => pool.query(`
    insert into customers (id, organization_id, name, phone, phone_key)
    values ($1, $2, $3, $4, $5)`, [id, org, name, phone, key])

  await add('cc_1', ORG, 'Dewi', '0812345678', '62812345678')
  let refused = false
  try { await add('cc_2', ORG, 'Dewi Lagi', '+62812345678', '62812345678') }
  catch { refused = true }
  ok('a second customer with the same number is refused', refused)

  // A salon may hold any number of customers with no phone. This works because
  // Postgres treats NULLs as distinct in a unique index -- the index being
  // partial is a size optimisation, not the reason. Asserted because the
  // BEHAVIOUR is what the walk-in case depends on, whatever enforces it.
  await add('cc_3', ORG, 'Walk-in Satu', null, null)
  let secondNullOk = true
  try { await add('cc_4', ORG, 'Walk-in Dua', null, null) }
  catch { secondNullOk = false }
  ok('two customers with no phone both save', secondNullOk)

  // Uniqueness is per salon, not global -- another salon's customer may share
  // the number without colliding.
  let otherSalonOk = true
  try { await add('cc_5', ORG2, 'Dewi Salon Lain', '0812345678', '62812345678') }
  catch { otherSalonOk = false }
  ok('another salon may hold the same number', otherSalonOk)
  head('4. screens')
  const ownerEmail = `owner@${DOMAIN}`
  const owner = new Client()
  await owner.req('/sign-up/email', { name: 'Cust Owner', email: ownerEmail, password: PW })
  await pool.query(`update users set email_verified = true where email = $1`, [ownerEmail])
  await owner.req('/sign-in/email', { email: ownerEmail, password: PW })
  const org = await owner.req('/organization/create',
    { name: 'Cust Screens', slug: 'custcheck-screens' })
  const orgId = org.data?.id
  await owner.req('/organization/set-active', { organizationId: orgId })

  await pool.query(`
    insert into customers (id, organization_id, name, phone, phone_key)
    values ('cc_s1', $1, 'Sari Wijaya', '+62812999888', '62812999888'),
           ('cc_s2', $1, 'Budi Santoso', null, null)`, [orgId])

  // Search matches the NORMALISED key, so a domestic spelling finds a customer
  // stored in international form. Matching the raw phone column would miss
  // exactly the spellings normalisation exists to unify.
  const found = await page('/customers?q=0812999888', owner.cookie())
  ok('searching a domestic number finds an international-format customer',
     found.html.includes('Sari Wijaya'), `status ${found.status}`)
  ok('and does not return everyone', !found.html.includes('Budi Santoso'))

  const byName = await page('/customers?q=Budi', owner.cookie())
  ok('searching by name works too', byName.html.includes('Budi Santoso'))

  // Another salon's id must read as not-found, never as a leak.
  await pool.query(`
    insert into customers (id, organization_id, name) values ('cc_other', $1, 'Rahasia Salon Lain')`,
    [ORG2])
  const foreign = await page('/customers/cc_other', owner.cookie())
  ok('another salon customer id is not a 200 with data', foreign.status !== 200,
     `got ${foreign.status}`)
  ok('and their name never appears', !foreign.html.includes('Rahasia Salon Lain'))

  head('5. permissions')
  const stylistEmail = `stylist@${DOMAIN}`
  const stylist = new Client()
  await stylist.req('/sign-up/email', { name: 'Cust Stylist', email: stylistEmail, password: PW })
  await pool.query(`update users set email_verified = true where email = $1`, [stylistEmail])
  const { rows: [su] } = await pool.query(`select id from users where email = $1`, [stylistEmail])
  await pool.query(`
    insert into members (id, user_id, organization_id, role, created_at)
    values ('cc_m_sty', $1, $2, 'stylist', now())`, [su.id, orgId])
  // Sign in AFTER the membership row exists: lib/auth.ts's session hook
  // resolves activeOrganizationId when the session is CREATED, so a sign-in
  // before this insert produces a session with no active org and every guarded
  // page redirects regardless of permissions.
  await stylist.req('/sign-in/email', { email: stylistEmail, password: PW })

  const styList = await page('/customers', stylist.cookie())
  ok('a stylist may read the list', styList.status === 200, `got ${styList.status}`)
  const styNew = await page('/customers/new', stylist.cookie())
  ok('but is redirected from create', styNew.status >= 300 && styNew.status < 400,
     `got ${styNew.status}`)
  const styEdit = await page('/customers/cc_s1', stylist.cookie())
  ok('and from the detail screen', styEdit.status >= 300 && styEdit.status < 400,
     `got ${styEdit.status}`)
} finally {
  await pool.end()
}

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m`)
process.exit(fail ? 1 : 0)
