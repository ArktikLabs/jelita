/**
 * Plan gating checks. No framework on purpose.
 *   pnpm plan:check      (dev server must be running)
 */
import { Pool } from 'pg'
import { PLANS } from './seed-plans.mjs'

// Free's caps come from the seed, not from literals repeated here: the
// restore below writes them back into the database, so a hardcoded copy would
// silently revert plan_limits to stale values the moment the seed changes.
const FREE = PLANS.find((p) => p.key === 'free')

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
  // Sections 4 and 9 below temporarily repoint free's branch and staff caps
  // to exercise the lock rule and pin a seat boundary; restore the seeded
  // values rather than deleting the rows, or plan_limits ends up missing them
  // for every run after the first — and a mid-run crash must not corrupt the
  // next run either.
  const restoreFreeCap = (resource) => pool.query(`
    insert into plan_limits (plan_id, resource, cap)
    select id, $1, $2 from plans where key = 'free'
    on conflict (plan_id, resource) do update set cap = excluded.cap`,
    [resource, FREE.caps[resource]])
  await restoreFreeCap('branches')
  await restoreFreeCap('staff')
  await pool.query(`delete from plans where key = 'plancheck_paid'`)
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`])
  await pool.query(`delete from organizations where slug like 'plancheck%'`)
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

  // A branches cap of 0 would fail signup after the organization and owner rows
  // commit and before the default team, leaving an orphan salon. Attempted in a
  // transaction that always rolls back, so a regression cannot corrupt the cap.
  const zeroBranches = await (async () => {
    const c = await pool.connect()
    try {
      await c.query('begin')
      await c.query(`update plan_limits set cap = 0
                      where resource = 'branches'
                        and plan_id = (select id from plans where is_default)`)
      return null
    } catch (e) {
      return e
    } finally {
      await c.query('rollback').catch(() => {})
      c.release()
    }
  })()
  ok('a branches cap of 0 is refused (it would break signup mid-write)',
    zeroBranches !== null, 'a zero-branch tier was accepted')

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
  const mkTeam = (id, n, at) => pool.query(
    `insert into teams (id, name, organization_id, created_at)
     values ($1, $2, 'plancheck_org', $3::timestamp)`,
    [`plancheck_t${id}`, n, at])
  // Branches 1 and 2 get a literal, byte-identical created_at: now() is
  // transaction_timestamp() and each pool.query is its own transaction, so
  // two now() calls differ by milliseconds and the view's `, t.id` tiebreak
  // would never actually decide anything.
  await mkTeam(1, 'Branch 1', '2026-01-01 00:00:01')
  await mkTeam(2, 'Branch 2', '2026-01-01 00:00:01')
  await mkTeam(3, 'Branch 3', '2026-01-01 00:00:02')

  const capTo = async (n) => {
    await pool.query(`
      insert into plan_limits (plan_id, resource, cap)
      select id, 'branches', $1 from plans where is_default
      on conflict (plan_id, resource) do update set cap = excluded.cap`, [n])
  }
  await capTo(1)
  const { rows: locked } = await pool.query(`
    select team_id, seq, within_cap from branch_entitlement
     where organization_id = 'plancheck_org' order by seq`)
  ok('only the oldest branch stays active at cap 1',
    locked.length === 3 && locked[0].within_cap === true
      && locked[1].within_cap === false && locked[2].within_cap === false,
    JSON.stringify(locked))
  // Says WHICH tied branch won: t1 and t2 share a created_at exactly, so the
  // lower id must take seq 1 and the other must be the locked one.
  ok('the (created_at, id) tiebreak gives the lower id the surviving seat',
    locked[0].team_id === 'plancheck_t1' && locked[1].team_id === 'plancheck_t2'
      && locked[2].team_id === 'plancheck_t3',
    JSON.stringify(locked.map((r) => r.team_id)))

  await capTo(3)
  const { rows: unlocked } = await pool.query(`
    select within_cap from branch_entitlement where organization_id = 'plancheck_org'`)
  ok('raising the cap re-activates with no manual unlock',
    unlocked.length === 3 && unlocked.every((r) => r.within_cap === true),
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
  await restoreFreeCap('branches')
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

  // In a transaction that is always rolled back: if the FK ever stops
  // restricting, the bare delete would succeed and take the payroll row with
  // it, breaking this whole section on every later run.
  const fkClient = await pool.connect()
  await fkClient.query('begin')
  const restrict = await fkClient.query(`delete from features where key = 'payroll'`)
    .then(() => null).catch((e) => e)
  await fkClient.query('rollback')
  fkClient.release()
  ok('deleting a feature a plan still sells is refused', restrict !== null,
    'payroll was deleted despite plan_features referencing it')

  // Same drift gap as FEATURE_KEYS above, one table over: CAPPED_RESOURCES and
  // the plan_limits_resource CHECK are hand-maintained copies of one list.
  const { CAPPED_RESOURCES } = await import('../lib/plan/catalog.ts')
  const { rows: [{ constraintdef }] } = await pool.query(
    `select pg_get_constraintdef(oid) as constraintdef
       from pg_constraint where conname = 'plan_limits_resource'`)
  const checkResources = [...constraintdef.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()
  ok('CAPPED_RESOURCES matches the plan_limits_resource CHECK exactly',
    JSON.stringify(checkResources) === JSON.stringify([...CAPPED_RESOURCES].sort()),
    JSON.stringify({ check: checkResources, ts: [...CAPPED_RESOURCES].sort() }))

  const { rows: planCount } = await pool.query(`select count(*)::int n from plans`)
  ok('four tiers seeded', planCount[0].n === 4, JSON.stringify(planCount))

  head('6. entitlement resolution over HTTP')
  await owner.req('/sign-up/email',
    { name: 'Plan Owner', email: `owner@${DOMAIN}`, password: PW })
  // requireEmailVerification is on, so sign-up alone leaves no session.
  // Verifying the fixture is the correct fix, not weakening the setting.
  await pool.query(
    `update users set email_verified = true where email like $1`,
    [`%@${DOMAIN}`],
  )
  await owner.req('/sign-in/email', { email: `owner@${DOMAIN}`, password: PW })
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
  ok(`free tier caps branches at ${FREE.caps.branches}`,
    ent.data?.caps?.branches === FREE.caps.branches, JSON.stringify(ent.data?.caps))

  head('7. quota enforcement')
  // free caps staff at FREE.caps.staff; the owner already occupies one seat.
  const mkStaff = (i) => owner.req('/staff', {
    name: `Staff ${i}`, email: `s${i}@${DOMAIN}`, password: PW, role: 'stylist',
  }, 'POST', `${ORIGIN}/api`)

  const s1 = await mkStaff(1)
  const s2 = await mkStaff(2)
  ok('staff can be added while under cap',
    s1.status === 201 && s2.status === 201,
    JSON.stringify([s1.status, s2.status]))

  const s3 = await mkStaff(3)
  ok('staff creation past the cap returns 402', s3.status === 402, `got ${s3.status}`)
  ok('402 body names the resource, cap and usage',
    s3.data?.error === 'QUOTA_EXCEEDED' && s3.data?.resource === 'staff'
      && s3.data?.cap === FREE.caps.staff && s3.data?.used === FREE.caps.staff,
    JSON.stringify(s3.data))

  await pool.query(`
    update subscriptions set plan_id = (select id from plans where key = 'business')
     where organization_id = $1`, [orgId])
  const s4 = await mkStaff(4)
  ok('upgrading to an uncapped tier allows creation again',
    s4.status === 201, JSON.stringify(s4.data))
  await pool.query(`
    update subscriptions set plan_id = (select id from plans where key = 'free')
     where organization_id = $1`, [orgId])

  head('8. better-auth endpoints respect caps')
  // free caps branches at 1, and the org's auto-created team is branch #1.
  const extraTeam = await owner.req('/organization/create-team',
    { name: 'Second Branch', organizationId: orgId })
  ok('creating a branch past the cap is refused',
    extraTeam.status === 402, `got ${extraTeam.status} ${JSON.stringify(extraTeam.data)}`)

  await pool.query(`
    update subscriptions set plan_id = (select id from plans where key = 'pro')
     where organization_id = $1`, [orgId])
  const allowed = await owner.req('/organization/create-team',
    { name: 'Second Branch', organizationId: orgId })
  ok('the same call succeeds on a tier with room',
    allowed.status === 200, `got ${allowed.status} ${JSON.stringify(allowed.data)}`)
  await pool.query(`
    update subscriptions set plan_id = (select id from plans where key = 'free')
     where organization_id = $1`, [orgId])

  // better-auth resolves the target org as `ctx.body.organizationId ||
  // session.activeOrganizationId`, so the quota must be charged to the org in
  // the BODY. An owner whose ACTIVE salon is uncapped must still not be able
  // to create a branch in a capped salon they also belong to.
  const org2 = await owner.req('/organization/create',
    { name: 'Plan Check Salon 2', slug: 'plancheck2' })
  const org2Id = org2.data?.id
  await pool.query(`
    update subscriptions set plan_id = (select id from plans where key = 'business')
     where organization_id = $1`, [org2Id])
  const active2 = await owner.req('/organization/set-active', { organizationId: org2Id })
  ok('the caller\'s active org is now the uncapped second salon',
    active2.data?.id === org2Id, JSON.stringify(active2.data))
  const crossOrg = await owner.req('/organization/create-team',
    { name: 'Cross Org Branch', organizationId: orgId })
  ok('create-team is quota-checked against the body\'s organizationId, not the active org',
    crossOrg.status === 402 && crossOrg.data?.error === 'QUOTA_EXCEEDED'
      && crossOrg.data?.resource === 'branches',
    `got ${crossOrg.status} ${JSON.stringify(crossOrg.data)}`)
  await owner.req('/organization/set-active', { organizationId: orgId })

  // A guard that throws a non-APIError from a global before-hook surfaces as a
  // bodyless 500; the endpoint's own session check must be what answers here.
  const anonTeam = await new Client().req('/organization/create-team',
    { name: 'Nobody Branch', organizationId: orgId })
  ok('unauthenticated create-team returns 401, not 500',
    anonTeam.status === 401, `got ${anonTeam.status} ${JSON.stringify(anonTeam.data)}`)

  head('9. better-auth endpoints respect the staff cap (not just branches)')
  // Pin free's staff cap to exactly one seat above the org's current member
  // count, so there is precisely one free seat to invite into and then fill
  // — the exact boundary the accept-invitation org-resolution fix depends on.
  const { rows: memberCountRow } = await pool.query(
    `select count(*)::int as n from members where organization_id = $1`, [orgId])
  const staffCap = memberCountRow[0].n + 1
  await pool.query(`
    update plan_limits set cap = $1
     where plan_id = (select id from plans where key = 'free') and resource = 'staff'`,
    [staffCap])

  const invitee = new Client()
  await invitee.req('/sign-up/email',
    { name: 'Plan Invitee', email: `invitee@${DOMAIN}`, password: PW })
  await pool.query(
    `update users set email_verified = true where email = $1`,
    [`invitee@${DOMAIN}`],
  )
  await invitee.req('/sign-in/email', { email: `invitee@${DOMAIN}`, password: PW })
  const inv1 = await owner.req('/organization/invite-member',
    { email: `invitee@${DOMAIN}`, role: 'stylist', organizationId: orgId })
  ok('invite-member succeeds while a seat remains',
    inv1.status === 200, `got ${inv1.status} ${JSON.stringify(inv1.data)}`)

  // Fill the remaining seat directly (via our own route, not accept-invitation)
  // so the org sits exactly at cap when the invitee accepts below.
  const filler = await owner.req('/staff', {
    name: 'Filler', email: `filler@${DOMAIN}`, password: PW, role: 'stylist',
  }, 'POST', `${ORIGIN}/api`)
  ok('filling the last seat succeeds', filler.status === 201, JSON.stringify(filler.data))

  const acceptAtCap = await invitee.req('/organization/accept-invitation',
    { invitationId: inv1.data?.id })
  ok('accept-invitation is refused once the invitation\'s org is at its staff cap',
    acceptAtCap.status === 402
      && acceptAtCap.data?.error === 'QUOTA_EXCEEDED'
      && acceptAtCap.data?.resource === 'staff'
      && acceptAtCap.data?.cap === staffCap
      && acceptAtCap.data?.used === staffCap,
    JSON.stringify(acceptAtCap.data))

  const inviteAtCap = await owner.req('/organization/invite-member',
    { email: `invitee2@${DOMAIN}`, role: 'stylist', organizationId: orgId })
  ok('invite-member is refused (courtesy check) once staff is at cap',
    inviteAtCap.status === 402
      && inviteAtCap.data?.error === 'QUOTA_EXCEEDED'
      && inviteAtCap.data?.resource === 'staff'
      && inviteAtCap.data?.cap === staffCap
      && inviteAtCap.data?.used === staffCap,
    JSON.stringify(inviteAtCap.data))

  await restoreFreeCap('staff')

  head('10. getBranchStatus() — the function requireBranch actually calls')
  // Section 4 already proves the branch_entitlement VIEW's lock rule on
  // synthetic teams. This section proves the getBranchStatus() FUNCTION
  // that requireBranch depends on — via a real import, not another direct
  // query — against the two real branches the HTTP flow above created.
  const { getBranchStatus } = await import('../lib/plan/branch.ts')

  await pool.query(`
    update subscriptions set plan_id = (select id from plans where key = 'pro')
     where organization_id = $1`, [orgId])
  const { rows: branchRows } = await pool.query(
    `select team_id, seq from branch_entitlement
      where organization_id = $1 order by seq`, [orgId])
  const [branch1, branch2] = branchRows
  const bothOnPro = [await getBranchStatus(branch1.team_id, orgId), await getBranchStatus(branch2.team_id, orgId)]
  ok('getBranchStatus is ok for branches within the cap (pro, both branches)',
    bothOnPro.every((s) => s === 'ok'), JSON.stringify(bothOnPro))

  await pool.query(`
    update subscriptions set plan_id = (select id from plans where key = 'free')
     where organization_id = $1`, [orgId])
  const afterDowngrade = [await getBranchStatus(branch1.team_id, orgId), await getBranchStatus(branch2.team_id, orgId)]
  ok('getBranchStatus is over_cap for the newer branch after a downgrade',
    afterDowngrade[0] === 'ok' && afterDowngrade[1] === 'over_cap',
    JSON.stringify(afterDowngrade))

  await pool.query(`
    update subscriptions set plan_id = (select id from plans where key = 'pro')
     where organization_id = $1`, [orgId])
  const afterRaise = await getBranchStatus(branch2.team_id, orgId)
  ok('getBranchStatus is ok again after raising the cap, no manual unlock',
    afterRaise === 'ok', afterRaise)

  const unknown = await getBranchStatus('plancheck-nonexistent-branch-id', orgId)
  ok('getBranchStatus is ok for an unknown branch id (let other layers 404 it)',
    unknown === 'ok', unknown)

  await pool.query(`
    update subscriptions set plan_id = (select id from plans where key = 'free')
     where organization_id = $1`, [orgId])
} catch (e) {
  fail++
  console.error('\n\x1b[31mFATAL\x1b[0m', e.stack)
} finally {
  await pool.end()
}

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`)
process.exit(fail ? 1 : 0)
