/**
 * Staff management checks. No framework on purpose.
 *   pnpm staff:check      (dev server must be running for later sections)
 */
import { readFileSync } from 'node:fs'
import { Pool } from 'pg'

let pass = 0, fail = 0
const ok = (n, c, d) => (c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${n}`))
                           : (fail++, console.log(`  \x1b[31m✗\x1b[0m ${n}  ${d ?? ''}`)))
const head = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`)

const pool = new Pool({ connectionString: process.env.DIRECT_URL })
const ORG = 'staffcheck_org'
const ORG2 = 'staffcheck_org2'
const ORIGIN = process.env.BETTER_AUTH_URL
const BASE = `${ORIGIN}/api/auth`
const APP = `${ORIGIN}/api`
const DOMAIN = 'staffcheck.local'
const PW = 'demo12345'

// Cookie-jar client, copied from scripts/auth-check.mjs: email verification
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
  // slug LIKE, not id = any([ORG, ORG2]): section 3 creates its own
  // 'staffcheck-seat' organization through the real sign-up/create-org HTTP
  // path (it needs a real credentialed owner, which the raw SQL fixtures in
  // sections 1-2 don't have), and that row must not survive to the next run
  // either, or re-creating it collides on the unique slug.
  await pool.query(`delete from organizations where slug like 'staffcheck%'`)
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`])
  ok('cleared', true)

  head('1. schema')
  const { rows: [tbl] } = await pool.query(`
    select count(*)::int n from information_schema.tables
     where table_name = 'staff_profiles'`)
  ok('staff_profiles exists', tbl.n === 1)

  const { rows: [rls] } = await pool.query(`
    select relrowsecurity from pg_class where relname = 'staff_profiles'`)
  ok('RLS enabled', rls.relrowsecurity === true)

  // spec 7.1: one branch each is enforced by the SCHEMA, not by app code.
  // Asserted by attempting the violation, not by reading the catalogue -- a
  // constraint that exists but is deferrable or NOT VALID would still pass a
  // catalogue check while allowing the write.
  await pool.query(`
    insert into organizations (id, name, slug, created_at)
    values ($1, 'Staff Check 2', 'staffcheck2', now())`, [ORG2])
  await pool.query(`
    insert into users (id, name, email, email_verified, created_at, updated_at)
    values ('sc_dup', 'SC Dup', $1, true, now(), now())`, [`dup@${DOMAIN}`])
  await pool.query(`
    insert into staff_profiles (user_id, organization_id) values ('sc_dup', $1)`, [ORG2])
  let refused = false
  try {
    await pool.query(`
      insert into staff_profiles (user_id, organization_id) values ('sc_dup', $1)`, [ORG2])
  } catch { refused = true }
  ok('a second profile for one person in one salon is refused', refused)

  // spec 7.2: the backfill left nobody behind. Any member without a profile
  // would silently count as a seat forever (countResource fails open).
  const { rows: [orphan] } = await pool.query(`
    select count(*)::int n from members m
     where not exists (select 1 from staff_profiles s
                        where s.user_id = m.user_id
                          and s.organization_id = m.organization_id)`)
  ok('every existing member has a profile', orphan.n === 0)

  head('2. the trigger seeds a profile for every member')
  await pool.query(`
    insert into organizations (id, name, slug, created_at)
    values ($1, 'Staff Check', 'staffcheck', now())`, [ORG])
  await pool.query(`
    insert into users (id, name, email, email_verified, created_at, updated_at)
    values ('sc_owner', 'SC Owner', $1, true, now(), now())`,
    [`owner@${DOMAIN}`])
  await pool.query(`
    insert into members (id, user_id, organization_id, role, created_at)
    values ('sc_m_owner', 'sc_owner', $1, 'owner', now())`, [ORG])

  const { rows: [seeded] } = await pool.query(`
    select active, team_id from staff_profiles
     where user_id = 'sc_owner' and organization_id = $1`, [ORG])
  ok('a new member gets a profile', seeded !== undefined)
  ok('seeded active, with no branch', seeded?.active === true && seeded?.team_id === null)

  head('3. the backfill carries real rosters across (run from the migration file itself)')
  // Fix round 1: section 1's "every existing member has a profile" check runs
  // long after the trigger exists, so it reads 0 whether or not the
  // backfill's own INSERT ever matched a row -- it proves the trigger, which
  // section 2 already proves. The UPDATE that carries team_id across was
  // completely untested. Rather than hand-copy the backfill SQL into this
  // script (a copy only proves the copy, not the migration -- the trap this
  // project has fallen into twice), read the actual statements out of the
  // migration file and execute those.
  const migrationSql = readFileSync('db/migrations/0009_staff_profiles.sql', 'utf8')
  const statements = migrationSql.split('--> statement-breakpoint').map((s) => s.trim())
  const backfillInsert = statements.find((s) =>
    s.includes('insert into staff_profiles (user_id, organization_id)') && s.includes('from members m'))
  const backfillUpdate = statements.find((s) =>
    s.includes('update staff_profiles s') && s.includes('set team_id'))
  ok('found both backfill statements in the migration file', !!backfillInsert && !!backfillUpdate)

  // Pre-migration fixture: a branch (team) in the salon, a stylist and an
  // owner both already assigned to it via team_members, and -- critically --
  // NO staff_profiles row yet. The trigger exists now and would normally
  // seed one on member insert, so the trigger-created rows are deleted
  // afterward to recreate the state the real migration ran against.
  await pool.query(`
    insert into teams (id, name, organization_id, created_at)
    values ('sc_team1', 'Cabang Satu', $1, now())`, [ORG])
  await pool.query(`
    insert into users (id, name, email, email_verified, created_at, updated_at)
    values ('sc_stylist', 'SC Stylist', $1, true, now(), now())`,
    [`stylist@${DOMAIN}`])
  await pool.query(`
    insert into members (id, user_id, organization_id, role, created_at)
    values ('sc_m_stylist', 'sc_stylist', $1, 'stylist', now())`, [ORG])
  await pool.query(`
    insert into team_members (id, team_id, user_id, created_at)
    values ('sc_tm_stylist', 'sc_team1', 'sc_stylist', now())`)
  // sc_owner already exists from section 2 -- give it a stray team_members
  // row too. Real invites never do this to an owner, but the migration must
  // not care: the exclusion is by role, not by whether the row exists.
  await pool.query(`
    insert into team_members (id, team_id, user_id, created_at)
    values ('sc_tm_owner', 'sc_team1', 'sc_owner', now())`)
  await pool.query(`
    delete from staff_profiles where organization_id = $1
     and user_id in ('sc_stylist', 'sc_owner')`, [ORG])

  await pool.query(backfillInsert)
  await pool.query(backfillUpdate)

  const { rows: [stylistProfile] } = await pool.query(`
    select team_id from staff_profiles where user_id = 'sc_stylist' and organization_id = $1`, [ORG])
  const { rows: [ownerProfile] } = await pool.query(`
    select team_id from staff_profiles where user_id = 'sc_owner' and organization_id = $1`, [ORG])
  ok('backfill insert creates a profile for a member the trigger never covered',
    stylistProfile !== undefined && ownerProfile !== undefined)
  ok('backfill update carries an existing team_members assignment onto a non-management member',
    stylistProfile?.team_id === 'sc_team1', `got ${JSON.stringify(stylistProfile)}`)
  ok('backfill update excludes management roles -- an owner keeps no branch even with a stray team_members row',
    ownerProfile?.team_id === null, `got ${JSON.stringify(ownerProfile)}`)

  head('4. seat counting')
  // Correction to the brief: entitlements.ts imports react, ../db and
  // ../session and declares a class, so it cannot be loaded by plain Node
  // type-stripping the way lib/plan/catalog.ts and lib/plan/branch.ts can.
  // Assert the seat count through the real HTTP path instead: cap the
  // default plan's staff seats at 1, sign in as an owner who is alone in
  // their salon, and try to provision a second staff member. With only the
  // owner present, a 402 proves the owner itself consumed the one seat --
  // if the owner did not count, the call would have succeeded.
  const { rows: [freeCapBefore] } = await pool.query(`
    select l.cap from plan_limits l
      join plans p on p.id = l.plan_id
     where p.is_default and l.resource = 'staff'`)
  const seededStaffCap = freeCapBefore?.cap ?? null

  const setDefaultStaffCap = (cap) => pool.query(`
    insert into plan_limits (plan_id, resource, cap)
    select id, 'staff', $1 from plans where is_default
    on conflict (plan_id, resource) do update set cap = excluded.cap`, [cap])

  try {
    await setDefaultStaffCap(1)

    const seatOwner = new Client()
    await seatOwner.req('/sign-up/email',
      { name: 'SC Seat Owner', email: `seat@${DOMAIN}`, password: PW })
    await pool.query(`update users set email_verified = true where email = $1`,
      [`seat@${DOMAIN}`])
    await seatOwner.req('/sign-in/email', { email: `seat@${DOMAIN}`, password: PW })
    const seatOrg = await seatOwner.req('/organization/create',
      { name: 'Staff Check Seat', slug: 'staffcheck-seat' })
    const seatOrgId = seatOrg.data?.id
    await seatOwner.req('/organization/set-active', { organizationId: seatOrgId })

    const blocked = await seatOwner.req('/staff',
      { name: 'Nope', email: `nope@${DOMAIN}`, password: PW, role: 'stylist' },
      'POST', APP)
    ok('the owner consumes a seat', blocked.status === 402,
      `got ${blocked.status} ${JSON.stringify(blocked.data)}`)
  } finally {
    // A shared row left mutated breaks later sections -- restore it even if
    // an assertion above threw.
    if (seededStaffCap === null) {
      await pool.query(`
        delete from plan_limits l using plans p
         where l.plan_id = p.id and p.is_default and l.resource = 'staff'`)
    } else {
      await setDefaultStaffCap(seededStaffCap)
    }
  }

  head('5. provisioning writes the assignment pair')
  // Real owner via the HTTP path (the raw-SQL fixtures in sections 1-3 have
  // no credential account and cannot sign in). business has no plan_limits
  // rows at all, so quota can never interfere with this section regardless
  // of whatever the default tier's staff cap is seeded to right now.
  const assignOwner = new Client()
  await assignOwner.req('/sign-up/email',
    { name: 'SC Assign Owner', email: `assign-owner@${DOMAIN}`, password: PW })
  await pool.query(`update users set email_verified = true where email = $1`,
    [`assign-owner@${DOMAIN}`])
  await assignOwner.req('/sign-in/email', { email: `assign-owner@${DOMAIN}`, password: PW })
  const assignOrg = await assignOwner.req('/organization/create',
    { name: 'Staff Check Assign', slug: 'staffcheck-assign' })
  const assignOrgId = assignOrg.data?.id
  await assignOwner.req('/organization/set-active', { organizationId: assignOrgId })
  await pool.query(`
    update subscriptions set plan_id = (select id from plans where key = 'business')
     where organization_id = $1`, [assignOrgId])

  const branch = await assignOwner.req('/organization/create-team',
    { name: 'Cabang Assign', organizationId: assignOrgId })
  const branchId = branch.data?.id
  ok('branch created', !!branchId, JSON.stringify(branch.data))

  const stylistEmail = `assign-stylist@${DOMAIN}`
  const madeStylist = await assignOwner.req('/staff',
    { name: 'SC Assign Stylist', email: stylistEmail, password: PW, role: 'stylist', branchId },
    'POST', APP)
  ok('provisioning a stylist with a branchId succeeds',
    madeStylist.status === 201, `got ${madeStylist.status} ${JSON.stringify(madeStylist.data)}`)
  const stylistId = madeStylist.data?.user?.id

  const { rows: [stylistProfile2] } = await pool.query(`
    select team_id from staff_profiles
     where user_id = $1 and organization_id = $2`, [stylistId, assignOrgId])
  ok('provisioning writes staff_profiles.team_id to the requested branch',
    stylistProfile2?.team_id === branchId, `got ${JSON.stringify(stylistProfile2)}`)

  const { rows: [teamMemberRow] } = await pool.query(`
    select 1 from team_members where user_id = $1 and team_id = $2`, [stylistId, branchId])
  ok('provisioning also writes the matching team_members row',
    teamMemberRow !== undefined, `got ${JSON.stringify(teamMemberRow)}`)

  const adminEmail = `assign-admin@${DOMAIN}`
  const madeAdmin = await assignOwner.req('/staff',
    { name: 'SC Assign Admin', email: adminEmail, password: PW, role: 'admin' },
    'POST', APP)
  ok('provisioning without a branchId succeeds',
    madeAdmin.status === 201, `got ${madeAdmin.status} ${JSON.stringify(madeAdmin.data)}`)
  const adminId = madeAdmin.data?.user?.id

  const { rows: [adminProfile] } = await pool.query(`
    select team_id from staff_profiles
     where user_id = $1 and organization_id = $2`, [adminId, assignOrgId])
  ok('provisioning with no branch leaves staff_profiles.team_id null',
    adminProfile?.team_id === null, `got ${JSON.stringify(adminProfile)}`)

  head('6. assignment does not depend on role strings')
  // The bug this replaces: a custom management role like 'manajer' is not in
  // array['owner', 'admin'], so the old team_members + role-deny-list
  // predicate counted its holder as staff and made the branch permanently
  // undeactivatable, naming them as the blocker with no screen to remove
  // them. Assignment is now a staff_profiles row, not a role match.
  //
  // Proven through the real deactivation form, not a direct import: unlike
  // lib/plan/branch.ts (which imports '../pg-pool.ts' with an explicit
  // extension), lib/branch.ts imports './db' without one, and Node's native
  // TypeScript loader requires explicit extensions on relative specifiers --
  // confirmed by trying `await import('../lib/branch.ts')` here first, which
  // throws "Cannot find module '.../lib/db'".
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
  const isBranchActive = async (teamId) => (await pool.query(
    `select active from branch_profiles where team_id = $1`, [teamId])).rows[0]?.active

  const roleOwner = new Client()
  await roleOwner.req('/sign-up/email',
    { name: 'SC Role Owner', email: `role-owner@${DOMAIN}`, password: PW })
  await pool.query(`update users set email_verified = true where email = $1`,
    [`role-owner@${DOMAIN}`])
  await roleOwner.req('/sign-in/email', { email: `role-owner@${DOMAIN}`, password: PW })
  const roleOrg = await roleOwner.req('/organization/create',
    { name: 'Staff Check Role', slug: 'staffcheck-role' })
  const roleOrgId = roleOrg.data?.id
  await roleOwner.req('/organization/set-active', { organizationId: roleOrgId })
  // The free plan's branch cap is 1, already spent on the org's default
  // team -- business has no plan_limits rows at all, so a second branch is
  // unaffected by whatever the default tier's cap is seeded to right now.
  await pool.query(`
    update subscriptions set plan_id = (select id from plans where key = 'business')
     where organization_id = $1`, [roleOrgId])

  const roleBranch = await roleOwner.req('/organization/create-team',
    { name: 'Cabang Role', organizationId: roleOrgId })
  const roleBranchId = roleBranch.data?.id
  ok('branch created', !!roleBranchId, JSON.stringify(roleBranch.data))

  // Raw inserts, not provisionStaff: this member's staff_profiles row must be
  // seeded by the trigger with team_id null, exactly like an invited member --
  // the point is that a team_members row and a non-management role alone must
  // not be enough.
  const managerEmail = `role-manajer@${DOMAIN}`
  await pool.query(`
    insert into users (id, name, email, email_verified, created_at, updated_at)
    values ('sc_manajer', 'SC Manajer', $1, true, now(), now())`, [managerEmail])
  await pool.query(`
    insert into members (id, user_id, organization_id, role, created_at)
    values ('sc_m_manajer', 'sc_manajer', $1, 'manajer', now())`, [roleOrgId])
  await pool.query(`
    insert into team_members (id, team_id, user_id, created_at)
    values ('sc_tm_manajer', $1, 'sc_manajer', now())`, [roleBranchId])

  const { rows: [manajerProfile] } = await pool.query(`
    select team_id from staff_profiles where user_id = 'sc_manajer' and organization_id = $1`,
    [roleOrgId])
  ok('the trigger seeded a profile with no branch, despite the team_members row',
    manajerProfile?.team_id === null, `got ${JSON.stringify(manajerProfile)}`)

  const beforeAssign = await submitForm(roleOwner.jar,
    `/branches/${roleBranchId}`, 'Nonaktifkan cabang</button>')
  ok('a custom-role member with only a team_members row does not block deactivation',
    await isBranchActive(roleBranchId) === false, `status ${beforeAssign.status}`)
  ok('and the block message never appears',
    !beforeAssign.html.includes('Pindahkan staf berikut lebih dulu'),
    beforeAssign.html.slice(0, 200))

  await submitForm(roleOwner.jar, `/branches/${roleBranchId}`, 'Aktifkan cabang</button>')

  await pool.query(`
    update staff_profiles set team_id = $1
     where user_id = 'sc_manajer' and organization_id = $2`, [roleBranchId, roleOrgId])

  const afterAssign = await submitForm(roleOwner.jar,
    `/branches/${roleBranchId}`, 'Nonaktifkan cabang</button>')
  ok('once staff_profiles.team_id is set, the same custom-role member blocks deactivation, named',
    afterAssign.html.includes('Pindahkan staf berikut lebih dulu: SC Manajer.'),
    `status ${afterAssign.status}`)
  ok('the branch stayed open', await isBranchActive(roleBranchId) === true)

  head('7. /staff and /staff/new')
  // Fresh owner + branch, business plan so quota never interferes with the
  // provisioning below.
  const listOwner = new Client()
  await listOwner.req('/sign-up/email',
    { name: 'SC List Owner', email: `list-owner@${DOMAIN}`, password: PW })
  await pool.query(`update users set email_verified = true where email = $1`,
    [`list-owner@${DOMAIN}`])
  await listOwner.req('/sign-in/email', { email: `list-owner@${DOMAIN}`, password: PW })
  const listOrg = await listOwner.req('/organization/create',
    { name: 'Staff Check List', slug: 'staffcheck-list' })
  const listOrgId = listOrg.data?.id
  await listOwner.req('/organization/set-active', { organizationId: listOrgId })
  await pool.query(`
    update subscriptions set plan_id = (select id from plans where key = 'business')
     where organization_id = $1`, [listOrgId])

  const listBranch = await listOwner.req('/organization/create-team',
    { name: 'Cabang List', organizationId: listOrgId })
  const listBranchId = listBranch.data?.id
  ok('branch created', !!listBranchId, JSON.stringify(listBranch.data))

  // 1. A stylist created through the real /staff/new page and its Server
  // Action -- not the JSON API -- lands staff_profiles.team_id on the chosen
  // branch (spec §7.6, exercised through the new UI this time). Marker is
  // `name="password"`, unique to this page's form regardless of how the
  // Submit button's own text renders.
  const listStylistEmail = `list-stylist@${DOMAIN}`
  const createdStylist = await submitForm(listOwner.jar, '/staff/new', 'name="password"', {
    name: 'SC List Stylist', email: listStylistEmail, password: PW,
    role: 'stylist', teamId: listBranchId,
  })
  ok('creating a stylist with a branch redirects to /staff',
    createdStylist.status === 303 && (createdStylist.location ?? '').includes('/staff'),
    `got ${createdStylist.status} ${createdStylist.location}`)

  const { rows: [listStylistProfile] } = await pool.query(`
    select s.team_id from staff_profiles s
      join users u on u.id = s.user_id
     where u.email = $1 and s.organization_id = $2`, [listStylistEmail, listOrgId])
  ok('the stylist created through the form has team_id set to the chosen branch',
    listStylistProfile?.team_id === listBranchId, `got ${JSON.stringify(listStylistProfile)}`)

  // 2. An admin created without a branch has team_id null (§7.6).
  const listAdminEmail = `list-admin@${DOMAIN}`
  const createdAdmin = await submitForm(listOwner.jar, '/staff/new', 'name="password"', {
    name: 'SC List Admin', email: listAdminEmail, password: PW, role: 'admin',
  })
  ok('creating an admin with no branch redirects to /staff',
    createdAdmin.status === 303 && (createdAdmin.location ?? '').includes('/staff'),
    `got ${createdAdmin.status} ${createdAdmin.location}`)

  const { rows: [listAdminProfile] } = await pool.query(`
    select s.team_id from staff_profiles s
      join users u on u.id = s.user_id
     where u.email = $1 and s.organization_id = $2`, [listAdminEmail, listOrgId])
  ok('the admin created through the form has no branch',
    listAdminProfile?.team_id === null, `got ${JSON.stringify(listAdminProfile)}`)

  // 3/4. Only owner and admin hold staff:read -- front desk and stylist are
  // both redirected away from /staff (§7.12). The stylist from assertion 1
  // above is reused; a front desk account is provisioned fresh via the JSON
  // API (simpler than a second form submission for a role this section
  // doesn't otherwise need).
  const listDeskEmail = `list-desk@${DOMAIN}`
  const madeDesk = await listOwner.req('/staff',
    { name: 'SC List Desk', email: listDeskEmail, password: PW, role: 'frontdesk', branchId: listBranchId },
    'POST', APP)
  ok('front desk provisioned for the redirect check',
    madeDesk.status === 201, `got ${madeDesk.status} ${JSON.stringify(madeDesk.data)}`)

  const deskClient = new Client()
  await deskClient.req('/sign-in/email', { email: listDeskEmail, password: PW })
  const deskStaffPage = await fetch(`${ORIGIN}/staff`, {
    headers: { cookie: cookieOf(deskClient.jar) }, redirect: 'manual',
  })
  ok('front desk is redirected away from /staff',
    deskStaffPage.status === 307 && (deskStaffPage.headers.get('location') ?? '').includes('/dashboard'),
    `got ${deskStaffPage.status} ${deskStaffPage.headers.get('location')}`)

  const stylistClient = new Client()
  await stylistClient.req('/sign-in/email', { email: listStylistEmail, password: PW })
  const stylistStaffPage = await fetch(`${ORIGIN}/staff`, {
    headers: { cookie: cookieOf(stylistClient.jar) }, redirect: 'manual',
  })
  ok('a stylist is likewise redirected away from /staff',
    stylistStaffPage.status === 307 && (stylistStaffPage.headers.get('location') ?? '').includes('/dashboard'),
    `got ${stylistStaffPage.status} ${stylistStaffPage.headers.get('location')}`)

  // 5. Another salon's staff id reads as not-found (§7.13). Correction to
  // the brief: lib/staff.ts imports ./auth, which plain Node type-stripping
  // cannot load (confirmed the same way section 6's note confirms
  // lib/branch.ts is unloadable -- assume nothing under lib/ is importable
  // here unless proven otherwise). Driven over HTTP instead, from both ends
  // of the claim: the staff_profiles query is proven scoped by organization
  // (so it can never match ORG2's user for this org), and the route itself --
  // there is no /staff/[id] page in this task, so the request falls through
  // to Next's own not-found, not a 200 with data. ORG2 / 'sc_dup' is section
  // 1's fixture, reused per the brief -- inserting it again would collide on
  // the primary key.
  const { rows: crossScopeRows } = await pool.query(`
    select 1 from staff_profiles where user_id = 'sc_dup' and organization_id = $1`, [listOrgId])
  ok('the staff query is scoped by organization -- no row for another salon\'s user',
    crossScopeRows.length === 0)

  const crossPage = await fetch(`${ORIGIN}/staff/sc_dup`, {
    headers: { cookie: cookieOf(listOwner.jar) }, redirect: 'manual',
  })
  const crossHtml = await crossPage.text()
  ok('another salon\'s staff id is not a 200 with data',
    crossPage.status !== 200, `got ${crossPage.status}`)
  ok('and their name never appears in the response', !crossHtml.includes('SC Dup'))
} finally {
  await pool.end()
}

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m`)
process.exit(fail ? 1 : 0)
