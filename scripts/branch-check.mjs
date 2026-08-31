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

  ok('an active branch within cap is ok', await getBranchStatus('bc_s1', ORG2) === 'ok')

  await pool.query(`
    insert into plan_limits (plan_id, resource, cap)
    select id, 'branches', 1 from plans where is_default
    on conflict (plan_id, resource) do update set cap = 1`)
  ok('an active branch over cap is over_cap',
    await getBranchStatus('bc_s2', ORG2) === 'over_cap', await getBranchStatus('bc_s2', ORG2))

  await pool.query(`update branch_profiles set active = false where team_id = 'bc_s2'`)
  ok('a deactivated branch is closed, not over_cap',
    await getBranchStatus('bc_s2', ORG2) === 'closed', await getBranchStatus('bc_s2', ORG2))

  ok('an unknown branch id is ok', await getBranchStatus('bc_nonexistent', ORG2) === 'ok')

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
    await getBranchStatus(capHolder[0].team_id, org2.data.id) === 'ok',
    await getBranchStatus(capHolder[0].team_id, org2.data.id))

  await pool.query(`update branch_profiles set active = false where team_id = $1`,
    [capHolder[0].team_id])
  ok('a deactivated branch reports closed even though it was within cap',
    await getBranchStatus(capHolder[0].team_id, org2.data.id) === 'closed',
    await getBranchStatus(capHolder[0].team_id, org2.data.id))
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

  // ---------------------------------------------------------------------
  // Sections 9-12 drive the Server Actions themselves.
  //
  // A 'use server' action calls next/headers and cannot be invoked from a
  // standalone script. But Next renders every useActionState form's
  // progressive-enhancement fields ($ACTION_REF_n, $ACTION_n:0/1, $ACTION_KEY)
  // into the page HTML, so reading them back and POSTing them is exactly what a
  // browser with JS disabled does: the real action, behind the real page
  // guards, on the real session. That is carried finding 2's option (b).
  const cookieOf = (j) => [...j].map(([k, v]) => `${k}=${v}`).join('; ')
  const decodeHtml = (t) => t.replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  const getPage = async (j, path) => {
    const r = await fetch(ORIGIN + path, { headers: { cookie: cookieOf(j) }, redirect: 'manual' })
    return { status: r.status, html: await r.text() }
  }
  /** Submit the form on `path` whose markup contains `marker`. */
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
    return { status: r.status, html: await r.text() }
  }
  /** The BranchRow the layout handed the switcher, read out of the RSC payload. */
  const branchProp = async (j, teamId) => {
    const { html } = await getPage(j, '/dashboard')
    const m = html.replace(/\\+"/g, '"').match(new RegExp(`\\{"teamId":"${teamId}"[^}]*\\}`))
    return m ? JSON.parse(m[0]) : null
  }
  const isActive = async (teamId) => (await pool.query(
    `select active from branch_profiles where team_id = $1`, [teamId])).rows[0]?.active
  const setActive = (teamId, active) => pool.query(
    `update branch_profiles set active = $2 where team_id = $1`, [teamId, active])

  head('9. a branch created through the UI is switchable by its creator')
  // The cap is still 1 from section 2, and org2 already has three teams, so
  // /branches/new must show the upgrade message rather than a form it will
  // reject on submit (spec §8's requireQuota half).
  const atCapPage = await getPage(jar, '/branches/new')
  ok('/branches/new refuses at cap instead of rendering a doomed form',
    atCapPage.html.includes('Batas cabang paket Anda sudah tercapai')
      && !atCapPage.html.includes('name="name"'),
    `status ${atCapPage.status}`)

  await pool.query(`
    insert into plan_limits (plan_id, resource, cap)
    select id, 'branches', 5 from plans where is_default
    on conflict (plan_id, resource) do update set cap = 5`)

  const create = await submitForm(jar, '/branches/new', 'Simpan</button>',
    { name: 'Cabang Baru', address: 'Jl. Baru 1', phone: '02100000' })
  const { rows: made } = await pool.query(
    `select id from teams where organization_id = $1 and name = 'Cabang Baru'`, [org2.data.id])
  ok('createBranchAction creates the branch', made.length === 1, `status ${create.status}`)
  const newTeam = made[0]?.id ?? 'none'

  const { rows: enrolled } = await pool.query(
    `select 1 from team_members where team_id = $1 and user_id = $2`, [newTeam, owner[0].id])
  ok('the creator gets a team_members row for it', enrolled.length === 1)

  const enterNew = await call('/organization/set-active-team', { teamId: newTeam })
  ok('and can therefore switch into it — without the row set-active-team is FORBIDDEN',
    enterNew.status === 200, JSON.stringify(enterNew).slice(0, 160))

  const { rows: rank } = await pool.query(
    `select team_id, seq from branch_entitlement where organization_id = $1 order by seq`,
    [org2.data.id])
  ok('enrolment does not disturb the created_at lock ranking',
    rank[0]?.team_id === 'bl_t1' && rank.at(-1)?.team_id === newTeam, JSON.stringify(rank))

  // This section mutated the shared default-plan branches cap; restore it.
  await pool.query(`
    insert into plan_limits (plan_id, resource, cap)
    select id, 'branches', 1 from plans where is_default
    on conflict (plan_id, resource) do update set cap = 1`)

  head('10. deactivation is refused while STAFF are assigned')
  // Management membership is navigational; staff membership is assignment.
  // desk@ is frontdesk, so their row is a real assignment — unlike the owner's
  // own row, which better-auth creates for the default team and which used to
  // make every branch permanently undeactivatable.
  const { rows: desk } = await pool.query(`select id from users where email = $1`, [`desk@${DOMAIN}`])
  // The same distinction, on screen: the /branches "Staf" column must not
  // count the owner's navigation row, or it would climb every time a manager
  // switched into a branch — a number that changes because someone looked at a
  // page. newTeam's only member so far is its creator.
  ok('a branch whose only members are management reports 0 staff',
    (await branchProp(jar, newTeam))?.staffCount === 0,
    JSON.stringify(await branchProp(jar, newTeam)))

  await pool.query(
    `insert into team_members (id, team_id, user_id, created_at)
     values ('bl_tm3', $1, $2, now())`, [newTeam, desk[0].id])
  // staff_profiles is the source of truth now, not this team_members row --
  // the trigger seeded desk's profile with team_id null when they were
  // invited, so the raw team_members insert above is navigational only until
  // this assignment is recorded too.
  await pool.query(
    `update staff_profiles set team_id = $1 where user_id = $2 and organization_id = $3`,
    [newTeam, desk[0].id, org2.data.id])
  ok('assigning a front-desk/stylist member takes it to 1',
    (await branchProp(jar, newTeam))?.staffCount === 1,
    JSON.stringify(await branchProp(jar, newTeam)))

  const blocked = await submitForm(jar, `/branches/${newTeam}`, 'Nonaktifkan cabang</button>')
  ok('deactivation is refused while staff are assigned, and the error names them',
    blocked.html.includes('Pindahkan staf berikut lebih dulu: BC Desk.'),
    `status ${blocked.status}`)
  ok('the branch with staff stayed open', await isActive(newTeam) === true)

  // The inverse, and the regression test for the blocking bug: bl_t2's only
  // team_members row belongs to the owner, so it must close.
  const closed = await submitForm(jar, '/branches/bl_t2', 'Nonaktifkan cabang</button>')
  ok('a branch whose only members are management CAN be deactivated',
    await isActive('bl_t2') === false, `status ${closed.status}`)
  // Finding 6's symptom was that the page came back unchanged — same button,
  // no sign the write landed — so a second click errored about the state the
  // first click had created. (The `state.done` alert itself only survives the
  // JS path: without JS, React drops the returned state because the form's
  // action, and so its $ACTION_KEY, flips to reactivate on the re-render.)
  ok('the page comes back showing the new state, not the button that was clicked',
    closed.html.includes('Aktifkan cabang</button>')
      && !closed.html.includes('Nonaktifkan cabang</button>'))

  const reopened = await submitForm(jar, '/branches/bl_t2', 'Aktifkan cabang</button>')
  ok('reactivating through the same form reopens it',
    await isActive('bl_t2') === true, `status ${reopened.status}`)

  head('11. the last open branch cannot be closed')
  await setActive(newTeam, false)
  await setActive('bl_t2', false)
  const { rows: open1 } = await pool.query(
    `select p.team_id from branch_profiles p join teams t on t.id = p.team_id
      where t.organization_id = $1 and p.active`, [org2.data.id])
  ok('exactly one branch is open (the precondition)',
    open1.length === 1 && open1[0].team_id === 'bl_t1', JSON.stringify(open1))

  const lastOne = await submitForm(jar, '/branches/bl_t1', 'Nonaktifkan cabang</button>')
  ok('closing the last open branch is refused',
    lastOne.html.includes('Ini satu-satunya cabang aktif'), `status ${lastOne.status}`)
  ok('and it is still open', await isActive('bl_t1') === true)

  await setActive(newTeam, true)
  await setActive('bl_t2', true)

  head('12. a closed branch stays in the switcher; the list stays away from front desk')
  // t0 (the org's default team, named after the salon) has been closed since
  // section 4.
  // The switcher is a client component and base-ui renders its items only once
  // the popup opens, so what the assertion reads is the RSC payload it was
  // handed — the branches prop.
  const closedProp = await branchProp(jar, t0[0].id)
  ok('a closed branch is still offered in the switcher, flagged inactive',
    closedProp?.active === false, JSON.stringify(closedProp))
  const { branchLabel } = await import('../lib/branch-label.ts')
  ok('and the switcher labels it Nonaktif rather than dropping it',
    branchLabel({ name: 'Cabang Lama', active: false, withinCap: true })
      === 'Cabang Lama — Nonaktif')
  const enterClosed = await call('/organization/set-active-team', { teamId: t0[0].id })
  ok('a closed branch is selectable', enterClosed.status === 200,
    JSON.stringify(enterClosed).slice(0, 160))
  ok('and standing in it is read-only as closed, not locked',
    await getBranchStatus(t0[0].id, org2.data.id) === 'closed')

  // Front desk cannot switch, so the branch table must never enter their RSC
  // payload — props to a client component are serialized whether or not the
  // component renders them.
  deskJar.clear()
  await callDesk('/sign-in/email', { email: `desk@${DOMAIN}`, password: PW })
  const deskDash = await getPage(deskJar, '/dashboard')
  ok('front desk still sees which branch they are standing in',
    deskDash.html.includes('Cabang Baru'), `status ${deskDash.status}`)
  ok('front desk is not sent the rest of the salon\'s branches',
    !deskDash.html.includes('Cabang Dua') && !deskDash.html.includes('withinCap')
      && !deskDash.html.includes('Branch Login —'),
    'branch list leaked into a non-switching role\'s page')
} catch (e) {
  fail++
  console.error('\n\x1b[31mFATAL\x1b[0m', e.stack)
} finally {
  await pool.end()
}

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`)
process.exit(fail ? 1 : 0)
