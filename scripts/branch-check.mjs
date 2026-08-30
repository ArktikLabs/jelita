/**
 * Branch management checks. No framework on purpose.
 *   pnpm branch:check      (dev server must be running for later sections)
 */
import { Pool } from 'pg'

let pass = 0, fail = 0
const ok = (n, c, d) => (c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${n}`))
                           : (fail++, console.log(`  \x1b[31m✗\x1b[0m ${n}  ${d ?? ''}`)))
const head = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`)

const pool = new Pool({ connectionString: process.env.DIRECT_URL })
const ORG = 'branchcheck_org'
const ORG2 = 'branchcheck_org2'
const ORIGIN = process.env.BETTER_AUTH_URL
const DOMAIN = 'branchcheck.local'
const PW = 'demo12345'

try {
  head('0. reset test fixtures')
  // Unconditional, at the START of every run: later sections in this file
  // reuse fixtures created by earlier sections, so cleanup never happens
  // mid-run (a crash would poison the next run) or at a section's end (a
  // later section still needs the row).
  await pool.query(`delete from organizations where id = any($1)`, [[ORG, ORG2]])
  await pool.query(`delete from organizations where slug = 'branchlogin'`)
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`])
  await pool.query(`delete from plan_limits
                     where plan_id = (select id from plans where is_default)
                       and resource = 'branches'`)
  ok('cleared', true)

  head('1. the trigger configures every new branch')
  await pool.query(`
    insert into organizations (id, name, slug, created_at)
    values ($1, 'Branch Check', 'branchcheck', now())`, [ORG])
  const mkTeam = (id, name, offsetSec) => pool.query(
    `insert into teams (id, name, organization_id, created_at)
     values ($1, $2, $3, timestamp '2026-01-01 00:00:00' + ($4 || ' seconds')::interval)`,
    [id, name, ORG, offsetSec])
  await mkTeam('bc_t1', 'Cabang Satu', 1)

  const { rows: prof } = await pool.query(
    `select active from branch_profiles where team_id = 'bc_t1'`)
  ok('a new team gets exactly one profile row, active',
    prof.length === 1 && prof[0].active === true, JSON.stringify(prof))

  const { rows: hrs } = await pool.query(
    `select weekday, closed, opens_at, closes_at from branch_hours
      where team_id = 'bc_t1' order by weekday`)
  ok('a new team gets exactly seven hours rows, 0..6, none closed',
    hrs.length === 7
      && hrs.every((h, i) => h.weekday === i && h.closed === false),
    JSON.stringify(hrs.map((h) => h.weekday)))

  head('2. the lock ranking skips deactivated branches')
  await mkTeam('bc_t2', 'Cabang Dua', 2)
  await pool.query(`
    insert into plan_limits (plan_id, resource, cap)
    select id, 'branches', 1 from plans where is_default
    on conflict (plan_id, resource) do update set cap = 1`)

  const within = async () => {
    const { rows } = await pool.query(
      `select team_id, seq, within_cap from branch_entitlement
        where organization_id = $1 order by seq`, [ORG])
    return rows
  }
  const both = await within()
  ok('with both active, the older branch holds the only slot',
    both.length === 2 && both[0].team_id === 'bc_t1'
      && both[0].within_cap === true && both[1].within_cap === false,
    JSON.stringify(both))

  // The regression test for the trap in spec §6: deactivating the OLDER
  // branch must not leave the only open branch locked.
  await pool.query(`update branch_profiles set active = false,
                    deactivated_at = now() where team_id = 'bc_t1'`)
  const after = await within()
  ok('deactivating the older branch leaves the live one operable',
    after.length === 1 && after[0].team_id === 'bc_t2'
      && after[0].within_cap === true,
    JSON.stringify(after))

  head('3. getBranchStatus distinguishes the two read-only reasons')
  const { getBranchStatus } = await import('../lib/plan/branch.ts')
  // A separate org, not ORG: section 2 already spent ORG's cap-1 slot on
  // bc_t2, which would make bc_s1 read over_cap for the wrong reason.
  // Fixture cleanup is section 0's job only; nothing here deletes rows.
  await pool.query(`
    insert into organizations (id, name, slug, created_at)
    values ($1, 'Branch Check 2', 'branchcheck2', now())`, [ORG2])
  const mkTeam2 = (id, name, offsetSec) => pool.query(
    `insert into teams (id, name, organization_id, created_at)
     values ($1, $2, $3, timestamp '2026-01-01 00:00:00' + ($4 || ' seconds')::interval)`,
    [id, name, ORG2, offsetSec])
  await mkTeam2('bc_s1', 'Satu', 1)
  await mkTeam2('bc_s2', 'Dua', 2)

  ok('an active branch within cap is ok', await getBranchStatus('bc_s1') === 'ok')

  await pool.query(`
    insert into plan_limits (plan_id, resource, cap)
    select id, 'branches', 1 from plans where is_default
    on conflict (plan_id, resource) do update set cap = 1`)
  ok('an active branch over cap is over_cap',
    await getBranchStatus('bc_s2') === 'over_cap', await getBranchStatus('bc_s2'))

  await pool.query(`update branch_profiles set active = false where team_id = 'bc_s2'`)
  ok('a deactivated branch is closed, not over_cap',
    await getBranchStatus('bc_s2') === 'closed', await getBranchStatus('bc_s2'))

  ok('an unknown branch id is ok', await getBranchStatus('bc_nonexistent') === 'ok')

  head('4. a fresh login lands on an active branch')
  // call/jar/org2 are declared at try-block level (no nested block scope)
  // because later sections in this file reuse this HTTP helper, its cookie
  // jar, and this fixture organization.
  const jar = new Map()
  const call = async (path, body) => {
    const headers = { 'content-type': 'application/json', origin: ORIGIN }
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
    const res = await fetch(`${ORIGIN}/api/auth${path}`, {
      method: 'POST', headers, body: JSON.stringify(body ?? {}),
    })
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const kv = c.split(';')[0], i = kv.indexOf('=')
      const n = kv.slice(0, i), v = kv.slice(i + 1)
      if (v === '') jar.delete(n); else jar.set(n, v)
    }
    const t = await res.text()
    let d; try { d = JSON.parse(t) } catch { d = t }
    return { status: res.status, data: d }
  }

  await call('/sign-up/email', { name: 'BC Owner', email: `owner@${DOMAIN}`, password: PW })
  await pool.query(`update users set email_verified = true where email like $1`, [`%@${DOMAIN}`])
  await call('/sign-in/email', { email: `owner@${DOMAIN}`, password: PW })
  const org2 = await call('/organization/create', { name: 'Branch Login', slug: 'branchlogin' })
  await call('/organization/set-active', { organizationId: org2.data?.id })

  // The auto-created default team is branch #1. Deactivate it and add a live
  // one. Inserted directly (like sections 1-2's mkTeam) rather than through
  // /organization/create-team: that endpoint is quota-gated, and section 2
  // left the default plan's branches cap at 1 for the rest of this run.
  // Direct insert also sidesteps that create-team does not enrol its caller
  // — the owner needs an explicit team_members row to be eligible as the
  // resolved active team.
  const { rows: t0 } = await pool.query(
    `select id from teams where organization_id = $1 order by created_at, id limit 1`,
    [org2.data.id])
  const { rows: owner } = await pool.query(`select id from users where email = $1`, [`owner@${DOMAIN}`])
  await pool.query(
    `insert into teams (id, name, organization_id, created_at)
     values ('bl_t1', 'Cabang Aktif', $1, now())`, [org2.data.id])
  await pool.query(
    `insert into team_members (id, team_id, user_id, created_at)
     values ('bl_tm1', 'bl_t1', $1, now())`, [owner[0].id])
  await pool.query(`update branch_profiles set active = false where team_id = $1`, [t0[0].id])

  jar.clear()
  await call('/sign-in/email', { email: `owner@${DOMAIN}`, password: PW })
  const { rows: sess } = await pool.query(
    `select s.active_team_id, p.active
       from sessions s join users u on u.id = s.user_id
       left join branch_profiles p on p.team_id = s.active_team_id
      where u.email = $1 order by s.created_at desc limit 1`, [`owner@${DOMAIN}`])
  ok('a fresh login does not land on a deactivated branch',
    sess[0]?.active_team_id !== t0[0].id && sess[0]?.active === true,
    JSON.stringify(sess[0]))

  head('5. the switcher rejects a branch from another organization')
  // Reusing call/jar/org2/owner from section 4: the caller's session is
  // signed in and active in org2 ("Branch Login"). bc_t2 belongs to ORG
  // (section 1's organization) — a genuinely different tenant.
  //
  // switchBranchAction (app/(app)/actions.ts) is a 'use server' action that
  // calls next/headers internally, so it cannot be invoked directly from a
  // standalone script — it has no meaning outside a Next.js request. What we
  // CAN and do exercise here is both halves of its security property:
  //   (a) the exact scoping query the action runs itself, before ever
  //       calling better-auth, and
  //   (b) the underlying /organization/set-active-team endpoint the action
  //       delegates to, proving the cross-tenant switch is refused end to
  //       end regardless of which layer catches it.
  const { rows: foreign } = await pool.query(
    `select 1 from teams where id = $1 and organization_id = $2 limit 1`,
    ['bc_t2', org2.data.id])
  ok('the action\'s own org-scoping query finds no row for a foreign team',
    foreign.length === 0, JSON.stringify(foreign))

  const cross = await call('/organization/set-active-team', { teamId: 'bc_t2' })
  ok('switching to a team in another organization is refused',
    cross.status >= 400, JSON.stringify(cross))

  // Success path: a second live team in the caller's OWN organization.
  await pool.query(
    `insert into teams (id, name, organization_id, created_at)
     values ('bl_t2', 'Cabang Dua', $1, now())`, [org2.data.id])
  await pool.query(
    `insert into team_members (id, team_id, user_id, created_at)
     values ('bl_tm2', 'bl_t2', $1, now())`, [owner[0].id])

  const { rows: own } = await pool.query(
    `select 1 from teams where id = $1 and organization_id = $2 limit 1`,
    ['bl_t2', org2.data.id])
  ok('the action\'s own org-scoping query finds a row for the caller\'s own team',
    own.length === 1, JSON.stringify(own))

  const same = await call('/organization/set-active-team', { teamId: 'bl_t2' })
  ok('switching to a team in the caller\'s own organization succeeds',
    same.status === 200, JSON.stringify(same))

  const { rows: switched } = await pool.query(
    `select active_team_id from sessions s join users u on u.id = s.user_id
      where u.email = $1 order by s.created_at desc limit 1`, [`owner@${DOMAIN}`])
  ok('sessions.active_team_id updates to the newly switched branch',
    switched[0]?.active_team_id === 'bl_t2', JSON.stringify(switched[0]))

  head('6. deactivating does not give a plan slot back')
  // Put the org at its branch cap, deactivate one branch, and confirm creating
  // another is STILL refused. countResource counts every team on purpose.
  await pool.query(`
    insert into plan_limits (plan_id, resource, cap)
    select id, 'branches', 2 from plans where is_default
    on conflict (plan_id, resource) do update set cap = 2`)

  const atCap = await call('/organization/create-team',
    { name: 'Cabang Ketiga', organizationId: org2.data.id })
  ok('creating past the cap is refused', atCap.status === 402, `got ${atCap.status}`)

  const { rows: live2 } = await pool.query(
    `select t.id from teams t join branch_profiles p on p.team_id = t.id
      where t.organization_id = $1 and p.active order by t.created_at desc limit 1`,
    [org2.data.id])
  await pool.query(`update branch_profiles set active = false where team_id = $1`,
    [live2[0].id])

  const stillAtCap = await call('/organization/create-team',
    { name: 'Cabang Ketiga', organizationId: org2.data.id })
  ok('deactivating a branch does NOT free a slot — creation still refused',
    stillAtCap.status === 402, `got ${stillAtCap.status}`)

  await pool.query(`update branch_profiles set active = true where team_id = $1`,
    [live2[0].id])

  // This section mutated the shared default-plan branches cap; put it back
  // to the seeded value now rather than leaving it for a later section to
  // trip over (sections 2 and 3 already learned this lesson the hard way).
  await pool.query(`
    insert into plan_limits (plan_id, resource, cap)
    select id, 'branches', 1 from plans where is_default
    on conflict (plan_id, resource) do update set cap = 1`)

  head('7. a closed branch refuses writes as closed, not locked')
  // getBranchStatus was already imported in section 3 — reuse it.
  //
  // live2 (bl_t2) is the wrong fixture here: branch_entitlement ranks only
  // ACTIVE branches by created_at, and live2 is picked as the NEWEST active
  // one — with cap 1 (restored at the end of section 6) it is over_cap by
  // construction. Deactivating it would just re-prove "closed beats
  // over_cap", which section 3 already covers. The cap HOLDER (seq 1,
  // within_cap = true) is the one that must go from a genuine 'ok' to
  // 'closed' on deactivation — that's the actual claim of this section.
  const { rows: capHolder } = await pool.query(
    `select team_id from branch_entitlement
      where organization_id = $1 and within_cap order by seq limit 1`,
    [org2.data.id])
  ok('there is exactly one cap holder to deactivate', capHolder.length === 1,
    JSON.stringify(capHolder))
  ok('the cap holder genuinely reads ok before deactivation (the precondition)',
    await getBranchStatus(capHolder[0].team_id) === 'ok',
    await getBranchStatus(capHolder[0].team_id))

  await pool.query(`update branch_profiles set active = false where team_id = $1`,
    [capHolder[0].team_id])
  ok('a deactivated branch reports closed even though it was within cap',
    await getBranchStatus(capHolder[0].team_id) === 'closed',
    await getBranchStatus(capHolder[0].team_id))
  await pool.query(`update branch_profiles set active = true where team_id = $1`,
    [capHolder[0].team_id])

  head('8. /branches is closed to front desk')
  // Invite a front-desk user into org2, accept, sign in as them, and GET
  // /branches following no redirects. Same invite-and-accept sequence as
  // auth-check.mjs; call/jar are still the owner's authenticated session
  // from section 4, active in org2.
  const deskJar = new Map()
  const callDesk = async (path, body) => {
    const headers = { 'content-type': 'application/json', origin: ORIGIN }
    if (deskJar.size) headers.cookie = [...deskJar].map(([k, v]) => `${k}=${v}`).join('; ')
    const res = await fetch(`${ORIGIN}/api/auth${path}`, {
      method: 'POST', headers, body: JSON.stringify(body ?? {}),
    })
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const kv = c.split(';')[0], i = kv.indexOf('=')
      const n = kv.slice(0, i), v = kv.slice(i + 1)
      if (v === '') deskJar.delete(n); else deskJar.set(n, v)
    }
    const t = await res.text()
    let d; try { d = JSON.parse(t) } catch { d = t }
    return { status: res.status, data: d }
  }

  await callDesk('/sign-up/email', { name: 'BC Desk', email: `desk@${DOMAIN}`, password: PW })
  await pool.query(`update users set email_verified = true where email = $1`, [`desk@${DOMAIN}`])

  const deskInvite = await call('/organization/invite-member',
    { email: `desk@${DOMAIN}`, role: 'frontdesk', organizationId: org2.data.id })
  ok('front desk invited', deskInvite.status === 200, JSON.stringify(deskInvite.data).slice(0, 160))

  await callDesk('/sign-in/email', { email: `desk@${DOMAIN}`, password: PW })
  const deskAccept = await callDesk('/organization/accept-invitation',
    { invitationId: deskInvite.data?.id })
  ok('front desk accepted invitation', deskAccept.status === 200,
    JSON.stringify(deskAccept.data).slice(0, 160))
  await callDesk('/organization/set-active', { organizationId: org2.data.id })

  const res = await fetch(`${ORIGIN}/branches`, {
    headers: { cookie: [...deskJar].map(([k, v]) => `${k}=${v}`).join('; ') },
    redirect: 'manual',
  })
  ok('front desk is redirected away from /branches',
    res.status === 307 && (res.headers.get('location') ?? '').includes('/dashboard'),
    `got ${res.status} ${res.headers.get('location')}`)
} catch (e) {
  fail++
  console.error('\n\x1b[31mFATAL\x1b[0m', e.stack)
} finally {
  await pool.end()
}

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`)
process.exit(fail ? 1 : 0)
