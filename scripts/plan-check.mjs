/**
 * Plan gating checks. No framework on purpose.
 *   pnpm plan:check      (dev server must be running)
 */
import { Pool } from 'pg'

let pass = 0, fail = 0
const ok = (n, c, d) => (c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${n}`))
                           : (fail++, console.log(`  \x1b[31m✗\x1b[0m ${n}  ${d ?? ''}`)))
const head = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`)

const pool = new Pool({ connectionString: process.env.DIRECT_URL })

const ORIGIN = process.env.BETTER_AUTH_URL
const DOMAIN = 'plancheck.local'
const PW = 'demo12345'

class Client {
  constructor() { this.jar = new Map() }
  async req(path, body, method = 'POST', base = `${ORIGIN}/api/auth`) {
    const headers = { 'content-type': 'application/json', origin: ORIGIN }
    if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ')
    const res = await fetch(base + path, {
      method, headers,
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    })
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const kv = c.split(';')[0], i = kv.indexOf('=')
      const name = kv.slice(0, i), val = kv.slice(i + 1)
      if (val === '') this.jar.delete(name)
      else this.jar.set(name, val)
    }
    const t = await res.text()
    let d; try { d = JSON.parse(t) } catch { d = t }
    return { status: res.status, data: d }
  }
  get(path, base) { return this.req(path, undefined, 'GET', base) }
}

try {
  head('0. reset test fixtures')
  // organizations cascade to teams and subscriptions; plan_limits/plans rows
  // are cleaned individually since they don't hang off the organization FK.
  await pool.query(`delete from organizations where id = 'plancheck_org'`)
  // Section 4 below temporarily repoints the default plan's branch cap to
  // exercise the lock rule; restore the real seeded value (see
  // scripts/seed-plans.mjs) rather than deleting it, or plan_limits ends up
  // missing this row for every run after the first.
  await pool.query(`
    insert into plan_limits (plan_id, resource, cap)
    select id, 'branches', 1 from plans where key = 'free'
    on conflict (plan_id, resource) do update set cap = 1`)
  await pool.query(`delete from plans where key = 'plancheck_paid'`)
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`])
  await pool.query(`delete from organizations where slug = 'plancheck'`)
  ok('cleared stale test fixtures', true)

  const owner = new Client()

  head('1. schema')
  const { rows: tables } = await pool.query(`
    select table_name from information_schema.tables
     where table_schema = 'public'
       and table_name in ('features','plans','plan_limits','plan_features','subscriptions')
     order by table_name`)
  ok('all five plan tables exist',
    tables.length === 5, JSON.stringify(tables.map((t) => t.table_name)))

  const { rows: rls } = await pool.query(`
    select c.relname, c.relrowsecurity
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname in ('features','plans','plan_limits','plan_features','subscriptions')`)
  ok('RLS enabled on all plan tables',
    rls.length === 5 && rls.every((r) => r.relrowsecurity),
    JSON.stringify(rls))

  head('2. constraints')
  // The trigger below requires a default plan; Task 4 seeds the real tiers and
  // adopts this row via its own on-conflict upsert.
  await pool.query(`
    insert into plans (key, name, is_default) values ('free','Free', true)
    on conflict (key) do nothing`)

  const dupDefault = await pool.query(`
    insert into plans (key, name, is_default) values ('dup_default','Dup', true)
    returning id`).then(() => null).catch((e) => e)
  ok('a second is_default plan is refused', dupDefault !== null,
    'second default was accepted')
  if (dupDefault === null) await pool.query(`delete from plans where key = 'dup_default'`)

  const badResource = await pool.query(`
    insert into plan_limits (plan_id, resource, cap)
    select id, 'nonsense', 1 from plans where is_default`)
    .then(() => null).catch((e) => e)
  ok('an unknown limit resource is refused', badResource !== null,
    'bad resource was accepted')

  head('3. default plan trigger')
  const org = await pool.query(`
    insert into organizations (id, name, slug, created_at)
    values ('plancheck_org','Plan Check','plancheck', now()) returning id`)
  const { rows: sub } = await pool.query(
    `select s.status, p.key from subscriptions s
       join plans p on p.id = s.plan_id
      where s.organization_id = $1`, [org.rows[0].id])
  ok('new organization is auto-subscribed to the default plan',
    sub.length === 1 && sub[0].status === 'active', JSON.stringify(sub))

  head('4. lock rule')
  const mkTeam = (id, n, offsetSec) => pool.query(
    `insert into teams (id, name, organization_id, created_at)
     values ($1, $2, 'plancheck_org', now() + ($3 || ' seconds')::interval)`,
    [`plancheck_t${id}`, n, offsetSec])
  // branches 1 and 2 share a created_at on purpose, so the view's
  // `order by t.created_at, t.id` tiebreak (not just created_at) is what
  // decides seq for them.
  await mkTeam(1, 'Branch 1', 1)
  await mkTeam(2, 'Branch 2', 1)
  await mkTeam(3, 'Branch 3', 2)

  const capTo = async (n) => {
    await pool.query(`
      insert into plan_limits (plan_id, resource, cap)
      select id, 'branches', $1 from plans where is_default
      on conflict (plan_id, resource) do update set cap = excluded.cap`, [n])
  }
  await capTo(1)
  const { rows: locked } = await pool.query(`
    select team_id, seq, is_active from branch_entitlement
     where organization_id = 'plancheck_org' order by seq`)
  ok('only the oldest branch stays active at cap 1',
    locked.length === 3 && locked[0].is_active === true
      && locked[1].is_active === false && locked[2].is_active === false,
    JSON.stringify(locked))

  await capTo(3)
  const { rows: unlocked } = await pool.query(`
    select is_active from branch_entitlement where organization_id = 'plancheck_org'`)
  ok('raising the cap re-activates with no manual unlock',
    unlocked.length === 3 && unlocked.every((r) => r.is_active === true),
    JSON.stringify(unlocked))

  // Only the 'free' default plan has existed so far, so subscriptions.plan_id
  // has necessarily always equaled plans.id where is_default — a broken
  // effective_plan that ignores status entirely would pass the same way a
  // correct one does. Give the org a distinct non-default plan so canceled
  // vs. non-canceled resolve to visibly different ids.
  await pool.query(`
    insert into plans (key, name) values ('plancheck_paid','Plan Check Paid')
    on conflict (key) do nothing`)
  const { rows: paid } = await pool.query(`select id from plans where key = 'plancheck_paid'`)
  const { rows: def } = await pool.query(`select id from plans where is_default`)
  await pool.query(`update subscriptions set plan_id = $1, status = 'active'
                     where organization_id = 'plancheck_org'`, [paid[0].id])

  await pool.query(`update subscriptions set status = 'canceled'
                     where organization_id = 'plancheck_org'`)
  const { rows: cancelled } = await pool.query(`
    select plan_id from effective_plan where organization_id = 'plancheck_org'`)
  ok('canceled resolves to the default plan (not the subscribed plan)',
    String(cancelled[0].plan_id) === String(def[0].id)
      && String(cancelled[0].plan_id) !== String(paid[0].id),
    JSON.stringify({ cancelled, def, paid }))

  await pool.query(`update subscriptions set status = 'past_due'
                     where organization_id = 'plancheck_org'`)
  const { rows: pastDue } = await pool.query(`
    select plan_id from effective_plan where organization_id = 'plancheck_org'`)
  ok('past_due retains the subscribed plan, not the default',
    String(pastDue[0].plan_id) === String(paid[0].id)
      && String(pastDue[0].plan_id) !== String(def[0].id),
    JSON.stringify({ pastDue, def, paid }))

  await pool.query(`delete from organizations where id = 'plancheck_org'`)
  await pool.query(`
    insert into plan_limits (plan_id, resource, cap)
    select id, 'branches', 1 from plans where key = 'free'
    on conflict (plan_id, resource) do update set cap = 1`)
  await pool.query(`delete from plans where key = 'plancheck_paid'`)

  head('5. catalog integrity')
  const { FEATURE_KEYS } = await import('../lib/plan/catalog.ts')
  const { rows: dbFeatures } = await pool.query(`select key from features order by key`)
  const dbKeys = dbFeatures.map((r) => r.key).sort()
  const tsKeys = [...FEATURE_KEYS].sort()
  ok('every TS feature key exists in the features table',
    tsKeys.every((k) => dbKeys.includes(k)),
    JSON.stringify({ missing: tsKeys.filter((k) => !dbKeys.includes(k)) }))
  ok('every features row exists in the TS catalog',
    dbKeys.every((k) => tsKeys.includes(k)),
    JSON.stringify({ orphaned: dbKeys.filter((k) => !tsKeys.includes(k)) }))

  const restrict = await pool.query(`delete from features where key = 'payroll'`)
    .then(() => null).catch((e) => e)
  ok('deleting a feature a plan still sells is refused', restrict !== null,
    'payroll was deleted despite plan_features referencing it')

  const { rows: planCount } = await pool.query(`select count(*)::int n from plans`)
  ok('four tiers seeded', planCount[0].n === 4, JSON.stringify(planCount))

  head('6. entitlement resolution over HTTP')
  await owner.req('/sign-up/email',
    { name: 'Plan Owner', email: `owner@${DOMAIN}`, password: PW })
  const orgRes = await owner.req('/organization/create',
    { name: 'Plan Check Salon', slug: 'plancheck' })
  const orgId = orgRes.data?.id
  await owner.req('/organization/set-active', { organizationId: orgId })

  const ent = await owner.get('/me/entitlements', `${ORIGIN}/api`)
  ok('entitlements resolve for a new tenant',
    ent.status === 200 && ent.data?.planKey === 'free', JSON.stringify(ent.data))
  ok('free tier grants online_booking',
    (ent.data?.features ?? []).includes('online_booking'), JSON.stringify(ent.data?.features))
  ok('free tier does NOT grant payroll',
    !(ent.data?.features ?? []).includes('payroll'), JSON.stringify(ent.data?.features))
  ok('free tier caps branches at 1',
    ent.data?.caps?.branches === 1, JSON.stringify(ent.data?.caps))
} catch (e) {
  fail++
  console.error('\n\x1b[31mFATAL\x1b[0m', e.stack)
} finally {
  await pool.end()
}

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`)
process.exit(fail ? 1 : 0)
