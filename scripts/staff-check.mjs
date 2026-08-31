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
  // sc_dup must be a REAL, complete member of ORG2 -- a users + staff_profiles
  // row with no members row would make getStaff('sc_dup', anyOtherOrg) return
  // null (its inner join on members finds nothing) whether or not the query's
  // own organization_id filter exists at all, so the "another salon's staff
  // name never appears" assertion in section 7 would pass identically against
  // an unscoped query. Fix round 1 caught this -- same failure shape as the
  // brief's own two corrected assumptions about lib/branch.ts and lib/staff.ts,
  // one level deeper.
  await pool.query(`
    insert into members (id, user_id, organization_id, role, created_at)
    values ('sc_m_dup', 'sc_dup', $1, 'stylist', now())`, [ORG2])
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

  // Negative directions of the pairing rule -- correct in source, never
  // exercised until now: a stylist with no branch, and an admin with one.
  const badStylistEmail = `list-bad-stylist@${DOMAIN}`
  const badStylist = await submitForm(listOwner.jar, '/staff/new', 'name="password"', {
    name: 'SC Bad Stylist', email: badStylistEmail, password: PW, role: 'stylist',
  })
  ok('a stylist with no branch is refused, not redirected',
    badStylist.status === 200 && badStylist.html.includes('Pilih cabang untuk peran ini.'),
    `got ${badStylist.status}`)
  const { rows: badStylistRows } = await pool.query(
    `select 1 from users where email = $1`, [badStylistEmail])
  ok('and no user was created for it', badStylistRows.length === 0)

  const badAdminEmail = `list-bad-admin@${DOMAIN}`
  const badAdmin = await submitForm(listOwner.jar, '/staff/new', 'name="password"', {
    name: 'SC Bad Admin', email: badAdminEmail, password: PW, role: 'admin', teamId: listBranchId,
  })
  ok('an admin with a branch is refused, not redirected',
    badAdmin.status === 200 && badAdmin.html.includes('Peran ini tidak ditempatkan di cabang.'),
    `got ${badAdmin.status}`)
  const { rows: badAdminRows } = await pool.query(
    `select 1 from users where email = $1`, [badAdminEmail])
  ok('and no user was created for it', badAdminRows.length === 0)

  // A teamId belonging to ANOTHER salon (section 3's 'sc_team1', under ORG,
  // not this section's listOrgId) must get our own Indonesian copy, not
  // addMember's English "Team not found" leaking verbatim through formError.
  const badTeamEmail = `list-bad-team@${DOMAIN}`
  const badTeam = await submitForm(listOwner.jar, '/staff/new', 'name="password"', {
    name: 'SC Bad Team', email: badTeamEmail, password: PW, role: 'stylist', teamId: 'sc_team1',
  })
  ok('a teamId from another salon is refused with Indonesian copy, not the English addMember message',
    badTeam.status === 200 && badTeam.html.includes('Cabang tidak ditemukan.')
      && !badTeam.html.includes('Team not found'),
    `got ${badTeam.status}`)
  const { rows: badTeamRows } = await pool.query(
    `select 1 from users where email = $1`, [badTeamEmail])
  ok('and no user was created for it', badTeamRows.length === 0)

  // The escalation this fix closes: role=owner with no branch used to pass
  // both pairing checks (NEEDS_BRANCH excludes 'owner', so neither line
  // objects) and provisionStaff's own `role in roles` gate (which also
  // includes 'owner'). staff:['create'] is held by admin as well as owner,
  // so this was a path from admin to owner. Asserted on the actual members
  // row count, not merely "an error came back" -- a refusal that still wrote
  // the user would pass a weaker check.
  const escalateEmail = `list-escalate@${DOMAIN}`
  const escalate = await submitForm(listOwner.jar, '/staff/new', 'name="password"', {
    name: 'SC Escalate', email: escalateEmail, password: PW, role: 'owner',
  })
  ok('posting role=owner is refused, not redirected',
    escalate.status === 200 && escalate.html.includes('Peran tidak valid.'),
    `got ${escalate.status}`)
  const { rows: escalateMembers } = await pool.query(`
    select 1 from members m join users u on u.id = m.user_id
     where u.email = $1 and m.organization_id = $2`, [escalateEmail, listOrgId])
  ok('and it created no member row', escalateMembers.length === 0,
    `got ${JSON.stringify(escalateMembers)}`)

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

  head('8. /staff/[id] -- role change and branch transfer')
  const CLOSED_MSG = 'Cabang ini nonaktif. Aktifkan dulu sebelum menempatkan staf.'
  const OVERCAP_MSG = 'Cabang ini terkunci oleh batas paket. Upgrade untuk menempatkan staf.'

  // getBranchStatus is importable by plain Node (self-contained, imports
  // '../pg-pool.ts' with an explicit extension) -- branch-check.mjs already
  // relies on this, confirmed the same way here rather than assumed.
  const { getBranchStatus } = await import('../lib/plan/branch.ts')

  // 8a. Role change (§7.7). Reuses section 7's fixtures: listStylistEmail
  // (assigned to listBranchId) and listAdminEmail (no branch).
  const { rows: [roleStylist] } = await pool.query(`
    select s.user_id from staff_profiles s join users u on u.id = s.user_id
     where u.email = $1 and s.organization_id = $2`, [listStylistEmail, listOrgId])
  const { rows: [roleAdmin] } = await pool.query(`
    select s.user_id from staff_profiles s join users u on u.id = s.user_id
     where u.email = $1 and s.organization_id = $2`, [listAdminEmail, listOrgId])

  const promoted = await submitForm(listOwner.jar, `/staff/${roleStylist.user_id}`,
    'Simpan peran</button>', { userId: roleStylist.user_id, role: 'admin' })
  ok('promoting a stylist to admin succeeds', promoted.status === 200,
    `got ${promoted.status}`)
  const { rows: [afterPromote] } = await pool.query(`
    select m.role, s.team_id from members m
      join staff_profiles s on s.user_id = m.user_id and s.organization_id = m.organization_id
     where m.user_id = $1 and m.organization_id = $2`, [roleStylist.user_id, listOrgId])
  ok('the member role is now admin', afterPromote?.role === 'admin', JSON.stringify(afterPromote))
  ok('promoting to a management role clears the branch (spec §7.7)',
    afterPromote?.team_id === null, JSON.stringify(afterPromote))

  const demoted = await submitForm(listOwner.jar, `/staff/${roleAdmin.user_id}`,
    'Simpan peran</button>', { userId: roleAdmin.user_id, role: 'stylist' })
  ok('demoting an admin to stylist without a branch is refused',
    demoted.status === 200 && demoted.html.includes('Pilih cabang untuk peran ini.'),
    `got ${demoted.status}`)
  const { rows: [stillAdmin] } = await pool.query(`
    select role from members where user_id = $1 and organization_id = $2`,
    [roleAdmin.user_id, listOrgId])
  ok('and the role was left unchanged', stillAdmin?.role === 'admin', JSON.stringify(stillAdmin))

  // 8b. An admin cannot demote or remove the owner (§6.1, carried forward).
  const adminClient = new Client()
  await adminClient.req('/sign-in/email', { email: listAdminEmail, password: PW })
  const { rows: [ownerRow] } = await pool.query(`
    select user_id from members where organization_id = $1 and role = 'owner'`, [listOrgId])
  const demoteOwner = await submitForm(adminClient.jar, `/staff/${ownerRow.user_id}`,
    'Simpan peran</button>', { userId: ownerRow.user_id, role: 'stylist', teamId: listBranchId })
  ok('an admin cannot change the owner\'s role',
    demoteOwner.status === 200 && demoteOwner.html.includes('Hanya pemilik yang dapat mengubah peran pemilik.'),
    `got ${demoteOwner.status}`)
  const { rows: [ownerStillOwner] } = await pool.query(`
    select role from members where user_id = $1 and organization_id = $2`,
    [ownerRow.user_id, listOrgId])
  ok('and the owner keeps their role', ownerStillOwner?.role === 'owner',
    JSON.stringify(ownerStillOwner))

  // 8c. Branch-status guard fixtures -- a fresh owner + org on the 'pro'
  // plan (branches cap 3, fixed by seed-plans.mjs, so nothing shared here
  // needs restoring afterward, unlike sections 4 and 6's default-plan cap).
  // Extra branches are raw INSERTs into teams, not '/organization/create-team'
  // -- that endpoint's own assertQuota would refuse anything past the cap
  // (proven in branch-check.mjs section 6), which is exactly the state this
  // fixture needs to reach.
  const guardOwner = new Client()
  await guardOwner.req('/sign-up/email',
    { name: 'SC Guard Owner', email: `guard-owner@${DOMAIN}`, password: PW })
  await pool.query(`update users set email_verified = true where email = $1`,
    [`guard-owner@${DOMAIN}`])
  await guardOwner.req('/sign-in/email', { email: `guard-owner@${DOMAIN}`, password: PW })
  const guardOrg = await guardOwner.req('/organization/create',
    { name: 'Staff Check Guard', slug: 'staffcheck-guard' })
  const guardOrgId = guardOrg.data?.id
  await guardOwner.req('/organization/set-active', { organizationId: guardOrgId })
  await pool.query(`
    update subscriptions set plan_id = (select id from plans where key = 'pro')
     where organization_id = $1`, [guardOrgId])

  const mkGuardBranch = (id, name, offsetSec) => pool.query(`
    insert into teams (id, name, organization_id, created_at)
    values ($1, $2, $3, now() + ($4 || ' seconds')::interval)`,
    [id, name, guardOrgId, offsetSec])
  await mkGuardBranch('sc_guard_fill2', 'Cabang Guard 2', 1)
  await mkGuardBranch('sc_guard_fill3', 'Cabang Guard 3', 2)
  await mkGuardBranch('sc_guard_overcap', 'Cabang Guard Overcap', 3)
  await mkGuardBranch('sc_guard_closed', 'Cabang Guard Closed', 4)
  await mkGuardBranch('sc_guard_both', 'Cabang Guard Both', 5)

  const { rows: [guardDefault] } = await pool.query(`
    select id from teams where organization_id = $1 order by created_at limit 1`, [guardOrgId])
  const withinBranchId = guardDefault.id
  const overCapBranchId = 'sc_guard_overcap'
  const closedBranchId = 'sc_guard_closed'
  const bothBranchId = 'sc_guard_both'

  const { rows: guardRanked } = await pool.query(`
    select team_id, seq, within_cap from branch_entitlement
     where organization_id = $1 order by seq`, [guardOrgId])
  ok('the fixture has 6 branches ranked, cap 3 leaves exactly 3 within and 3 over',
    guardRanked.length === 6 && guardRanked.filter((r) => r.within_cap).length === 3,
    JSON.stringify(guardRanked))
  ok('the "overcap" fixture branch genuinely reads over_cap before any test touches it',
    await getBranchStatus(overCapBranchId) === 'over_cap', await getBranchStatus(overCapBranchId))

  // 8d. The branch-status guard applies to creation too (carried-forward
  // requirement 2), not only to transfer -- checked here before closedBranchId
  // is deactivated, then again below through transferStaffAction.
  const createOverCapEmail = `guard-create-overcap@${DOMAIN}`
  const createOverCap = await submitForm(guardOwner.jar, '/staff/new', 'name="password"', {
    name: 'SC Guard Create Overcap', email: createOverCapEmail, password: PW,
    role: 'stylist', teamId: overCapBranchId,
  })
  ok('creating a stylist on an over-cap branch is refused with the over-cap copy',
    createOverCap.status === 200 && createOverCap.html.includes(OVERCAP_MSG),
    `got ${createOverCap.status}`)
  const { rows: overCapCreateRows } = await pool.query(
    `select 1 from users where email = $1`, [createOverCapEmail])
  ok('and no user was created for it', overCapCreateRows.length === 0)

  // The precondition this section's fixture needs: genuinely over cap BEFORE
  // it is also closed, asserted here (not assumed) -- the trap this project
  // shipped once already, per the brief.
  ok('the "closed" fixture branch genuinely reads over_cap before it is closed',
    await getBranchStatus(closedBranchId) === 'over_cap', await getBranchStatus(closedBranchId))
  await pool.query(`update branch_profiles set active = false where team_id = $1`,
    [closedBranchId])
  ok('and now reads closed once deactivated',
    await getBranchStatus(closedBranchId) === 'closed', await getBranchStatus(closedBranchId))

  const createClosedEmail = `guard-create-closed@${DOMAIN}`
  const createClosed = await submitForm(guardOwner.jar, '/staff/new', 'name="password"', {
    name: 'SC Guard Create Closed', email: createClosedEmail, password: PW,
    role: 'stylist', teamId: closedBranchId,
  })
  ok('creating a stylist on a closed branch is refused with the closed copy',
    createClosed.status === 200 && createClosed.html.includes(CLOSED_MSG),
    `got ${createClosed.status}`)
  const { rows: closedCreateRows } = await pool.query(
    `select 1 from users where email = $1`, [createClosedEmail])
  ok('and no user was created for it', closedCreateRows.length === 0)

  // 8e. The same guard, exercised through transferStaffAction. A real
  // stylist, parked on the within-cap default branch, is the moving target.
  const guardStylistEmail = `guard-stylist@${DOMAIN}`
  const madeGuardStylist = await guardOwner.req('/staff',
    { name: 'SC Guard Stylist', email: guardStylistEmail, password: PW,
      role: 'stylist', branchId: withinBranchId },
    'POST', APP)
  ok('guard stylist provisioned', madeGuardStylist.status === 201,
    `got ${madeGuardStylist.status} ${JSON.stringify(madeGuardStylist.data)}`)
  const guardStylistId = madeGuardStylist.data?.user?.id

  const teamIdOf = async (userId) => (await pool.query(
    `select team_id from staff_profiles where user_id = $1 and organization_id = $2`,
    [userId, guardOrgId])).rows[0]?.team_id

  const xferClosed = await submitForm(guardOwner.jar, `/staff/${guardStylistId}`,
    'Pindahkan</button>', { userId: guardStylistId, teamId: closedBranchId })
  ok('transfer to a closed branch returns the closed copy (§7.10)',
    xferClosed.status === 200 && xferClosed.html.includes(CLOSED_MSG),
    `got ${xferClosed.status}`)
  ok('and the assignment did not change', await teamIdOf(guardStylistId) === withinBranchId)

  const xferOverCap = await submitForm(guardOwner.jar, `/staff/${guardStylistId}`,
    'Pindahkan</button>', { userId: guardStylistId, teamId: overCapBranchId })
  ok('transfer to a locked (over-cap) branch returns the over-cap copy (§7.10)',
    xferOverCap.status === 200 && xferOverCap.html.includes(OVERCAP_MSG),
    `got ${xferOverCap.status}`)
  ok('and the assignment did not change', await teamIdOf(guardStylistId) === withinBranchId)

  // 8f. Genuinely both: verified over_cap while active (precondition,
  // asserted above in the ranked-branches check and again here directly),
  // then closed -- closed must win (§7.10 assertion 5).
  ok('the "both" fixture branch genuinely reads over_cap before it is closed',
    await getBranchStatus(bothBranchId) === 'over_cap', await getBranchStatus(bothBranchId))
  await pool.query(`update branch_profiles set active = false where team_id = $1`,
    [bothBranchId])
  ok('and now reads closed once deactivated',
    await getBranchStatus(bothBranchId) === 'closed', await getBranchStatus(bothBranchId))

  const xferBoth = await submitForm(guardOwner.jar, `/staff/${guardStylistId}`,
    'Pindahkan</button>', { userId: guardStylistId, teamId: bothBranchId })
  ok('a branch that is both closed and locked yields the closed message (§7.10)',
    xferBoth.status === 200 && xferBoth.html.includes(CLOSED_MSG)
      && !xferBoth.html.includes(OVERCAP_MSG),
    `got ${xferBoth.status}`)
  ok('and the assignment did not change', await teamIdOf(guardStylistId) === withinBranchId)

  // 8g. assignBranch's own org-scoping exists() guard, exercised standalone
  // for the first time (carried-forward requirement 3). 'sc_team1' is
  // section 3's fixture, under ORG -- a different salon than guardOrgId.
  const { rows: beforeCross } = await pool.query(
    `select 1 from team_members where team_id = 'sc_team1' and user_id = $1`, [guardStylistId])
  ok('no team_members row for the foreign team exists yet (precondition)',
    beforeCross.length === 0)

  const xferCross = await submitForm(guardOwner.jar, `/staff/${guardStylistId}`,
    'Pindahkan</button>', { userId: guardStylistId, teamId: 'sc_team1' })
  ok('a transfer to another salon\'s team reads as not-found, not the foreign team\'s status',
    xferCross.status === 200 && xferCross.html.includes('Cabang tidak ditemukan.')
      && !xferCross.html.includes(CLOSED_MSG) && !xferCross.html.includes(OVERCAP_MSG),
    `got ${xferCross.status}`)
  ok('and the assignment did not change',
    await teamIdOf(guardStylistId) === withinBranchId, await teamIdOf(guardStylistId))
  const { rows: afterCross } = await pool.query(
    `select 1 from team_members where team_id = 'sc_team1' and user_id = $1`, [guardStylistId])
  ok('and no team_members row was created for the foreign team either',
    afterCross.length === 0)

  // 8h. The happy path: a transfer to a genuinely open, within-cap branch
  // succeeds and moves the assignment.
  const xferOk = await submitForm(guardOwner.jar, `/staff/${guardStylistId}`,
    'Pindahkan</button>', { userId: guardStylistId, teamId: 'sc_guard_fill2' })
  ok('transfer to an open branch succeeds', xferOk.status === 200,
    `got ${xferOk.status}`)
  ok('and the assignment moved', await teamIdOf(guardStylistId) === 'sc_guard_fill2',
    await teamIdOf(guardStylistId))
  const { rows: movedTeamMember } = await pool.query(
    `select 1 from team_members where team_id = 'sc_guard_fill2' and user_id = $1`,
    [guardStylistId])
  ok('and addTeamMember wrote the navigational team_members row too',
    movedTeamMember.length === 1)

  // 8i. transferStaffAction refuses a transfer targeting a management role
  // (fix round 1, item 1) -- owner and admin must keep team_id null (spec
  // §4). Forged from guardStylistId's OWN transfer form (their page still
  // has the Cabang card) with userId swapped to the owner: the point is that
  // the SERVER refuses this, not merely that the owner's own page hides the
  // card -- a client can submit whatever userId it likes.
  const { rows: [guardOwnerRow] } = await pool.query(
    `select user_id from members where organization_id = $1 and role = 'owner'`, [guardOrgId])
  const xferOwnerAttempt = await submitForm(guardOwner.jar, `/staff/${guardStylistId}`,
    'Pindahkan</button>', { userId: guardOwnerRow.user_id, teamId: 'sc_guard_fill2' })
  ok('a transfer targeting an owner is refused',
    xferOwnerAttempt.status === 200
      && xferOwnerAttempt.html.includes('Peran ini tidak ditempatkan di cabang.'),
    `got ${xferOwnerAttempt.status}`)
  ok('and the owner\'s team_id is still null (row state, not just the error)',
    await teamIdOf(guardOwnerRow.user_id) === null, await teamIdOf(guardOwnerRow.user_id))

  const ownerPage = await getPage(guardOwner.jar, `/staff/${guardOwnerRow.user_id}`)
  ok('and the owner\'s own detail page does not offer the transfer card',
    !ownerPage.html.includes('Pindahkan</button>'))

  head('9. departure -- deactivate, rehire, password reset')
  const QUOTA_MSG = 'Kuota staf paket Anda sudah tercapai. Upgrade untuk mengaktifkan kembali.'
  const LAST_OWNER_MSG = 'Ini pemilik terakhir yang aktif. Tunjuk pemilik lain lebih dulu.'
  const SELF_MSG = 'Anda tidak dapat menonaktifkan akun Anda sendiri.'
  const NEWPW = 'demo987654'
  const activeOf = async (userId, orgId) => (await pool.query(
    `select active from staff_profiles where user_id = $1 and organization_id = $2`,
    [userId, orgId])).rows[0]?.active

  // 9a/9b. The seat. Reuses section 4's dynamically-read `seededStaffCap` and
  // `setDefaultStaffCap` rather than re-deriving them -- one restore path, and
  // the value restored is the seeded one, never a literal.
  const capOwner = new Client()
  await capOwner.req('/sign-up/email',
    { name: 'SC Cap Owner', email: `cap-owner@${DOMAIN}`, password: PW })
  await pool.query(`update users set email_verified = true where email = $1`,
    [`cap-owner@${DOMAIN}`])
  await capOwner.req('/sign-in/email', { email: `cap-owner@${DOMAIN}`, password: PW })
  const capOrg = await capOwner.req('/organization/create',
    { name: 'Staff Check Cap', slug: 'staffcheck-cap' })
  const capOrgId = capOrg.data?.id
  await capOwner.req('/organization/set-active', { organizationId: capOrgId })

  let capLeaverId
  try {
    // Cap 2: the owner holds one seat, so exactly one hire fits.
    await setDefaultStaffCap(2)

    const leaver = await capOwner.req('/staff',
      { name: 'SC Cap Leaver', email: `cap-leaver@${DOMAIN}`, password: PW, role: 'admin' },
      'POST', APP)
    ok('the one free seat can be hired into', leaver.status === 201,
      `got ${leaver.status} ${JSON.stringify(leaver.data)}`)
    capLeaverId = leaver.data?.user?.id

    // The product decision, not a count query: the SAME hire is refused at a
    // full cap and then succeeds once a seat is freed. A count re-read would
    // pass even if deactivation freed nothing that creation actually consults.
    const hire = () => capOwner.req('/staff',
      { name: 'SC Cap Hire', email: `cap-hire@${DOMAIN}`, password: PW, role: 'admin' },
      'POST', APP)

    const refused = await hire()
    ok('at a full cap the next hire is refused with 402',
      refused.status === 402, `got ${refused.status} ${JSON.stringify(refused.data)}`)
    const { rows: noHire } = await pool.query(
      `select 1 from users where email = $1`, [`cap-hire@${DOMAIN}`])
    ok('and no user was created for the refused hire', noHire.length === 0)

    const left = await submitForm(capOwner.jar, `/staff/${capLeaverId}`,
      'Nonaktifkan staf</button>', { userId: capLeaverId })
    ok('deactivating the hire succeeds',
      left.status === 200 && await activeOf(capLeaverId, capOrgId) === false,
      `got ${left.status}`)

    const rehire = await hire()
    ok('deactivating frees the seat -- the identical hire now succeeds (spec 7.4)',
      rehire.status === 201, `got ${rehire.status} ${JSON.stringify(rehire.data)}`)

    // The cap is full again (owner + the new hire), so rehiring the leaver is
    // a 402, exactly like hiring (spec 7.5).
    const rehireLeaver = await submitForm(capOwner.jar, `/staff/${capLeaverId}`,
      'Aktifkan staf</button>', { userId: capLeaverId })
    ok('reactivating at the cap returns the 402 copy',
      rehireLeaver.status === 200 && rehireLeaver.html.includes(QUOTA_MSG),
      `got ${rehireLeaver.status}`)
    ok('and the profile is still inactive',
      await activeOf(capLeaverId, capOrgId) === false)
  } finally {
    if (seededStaffCap === null) {
      await pool.query(`
        delete from plan_limits l using plans p
         where l.plan_id = p.id and p.is_default and l.resource = 'staff'`)
    } else {
      await setDefaultStaffCap(seededStaffCap)
    }
  }
  const { rows: [restoredCap] } = await pool.query(`
    select l.cap from plan_limits l join plans p on p.id = l.plan_id
     where p.is_default and l.resource = 'staff'`)
  ok('the shared staff cap is back to its seeded value',
    (restoredCap?.cap ?? null) === seededStaffCap, `got ${JSON.stringify(restoredCap)}`)

  // 9c-9h. Session revocation and password reset, on the business plan so the
  // quota never interferes.
  const exitOwner = new Client()
  await exitOwner.req('/sign-up/email',
    { name: 'SC Exit Owner', email: `exit-owner@${DOMAIN}`, password: PW })
  await pool.query(`update users set email_verified = true where email = $1`,
    [`exit-owner@${DOMAIN}`])
  await exitOwner.req('/sign-in/email', { email: `exit-owner@${DOMAIN}`, password: PW })
  const exitOrg = await exitOwner.req('/organization/create',
    { name: 'Staff Check Exit', slug: 'staffcheck-exit' })
  const exitOrgId = exitOrg.data?.id
  await exitOwner.req('/organization/set-active', { organizationId: exitOrgId })
  await pool.query(`
    update subscriptions set plan_id = (select id from plans where key = 'business')
     where organization_id = $1`, [exitOrgId])
  const { rows: [exitOwnerRow] } = await pool.query(
    `select user_id from members where organization_id = $1 and role = 'owner'`, [exitOrgId])

  const madeExitStaff = await exitOwner.req('/staff',
    { name: 'SC Exit Staff', email: `exit-staff@${DOMAIN}`, password: PW, role: 'admin' },
    'POST', APP)
  ok('exit staff provisioned', madeExitStaff.status === 201,
    `got ${madeExitStaff.status} ${JSON.stringify(madeExitStaff.data)}`)
  const exitStaffId = madeExitStaff.data?.user?.id

  // Precondition, asserted rather than assumed: the cookie works BEFORE the
  // deactivation. Without this the "no longer authenticates" check below would
  // pass just as well against a sign-in that never succeeded.
  const exitStaffClient = new Client()
  await exitStaffClient.req('/sign-in/email', { email: `exit-staff@${DOMAIN}`, password: PW })
  const beforeExit = await exitStaffClient.get('/get-session')
  ok('the staff cookie authenticates before deactivation',
    beforeExit.data?.user?.id === exitStaffId, JSON.stringify(beforeExit.data))

  await submitForm(exitOwner.jar, `/staff/${exitStaffId}`,
    'Nonaktifkan staf</button>', { userId: exitStaffId })
  const afterExit = await exitStaffClient.get('/get-session')
  ok('deactivation revokes sessions -- the same cookie no longer authenticates (spec 7.11)',
    !afterExit.data?.user, JSON.stringify(afterExit.data))
  const { rows: exitSessions } = await pool.query(
    `select 1 from sessions where user_id = $1`, [exitStaffId])
  ok('and no session row survives for them', exitSessions.length === 0)

  // Rehire (business plan, no cap) so the password path has a live account.
  await submitForm(exitOwner.jar, `/staff/${exitStaffId}`,
    'Aktifkan staf</button>', { userId: exitStaffId })
  ok('reactivation with room in the plan succeeds',
    await activeOf(exitStaffId, exitOrgId) === true)

  const pwClient = new Client()
  await pwClient.req('/sign-in/email', { email: `exit-staff@${DOMAIN}`, password: PW })
  const beforeReset = await pwClient.get('/get-session')
  ok('the rehired staff can sign in again', beforeReset.data?.user?.id === exitStaffId)

  const reset = await submitForm(exitOwner.jar, `/staff/${exitStaffId}`,
    'name="password"', { userId: exitStaffId, password: NEWPW })
  ok('the reset form returns without an error', reset.status === 200
    && !reset.html.includes('Kata sandi minimal'), `got ${reset.status}`)
  const afterReset = await pwClient.get('/get-session')
  ok('password reset revokes sessions -- the pre-reset cookie is dead (spec 7.11)',
    !afterReset.data?.user, JSON.stringify(afterReset.data))

  // The password actually changed: a reset that only killed sessions would
  // pass the two checks above and nothing else.
  const oldPw = await new Client().req('/sign-in/email',
    { email: `exit-staff@${DOMAIN}`, password: PW })
  ok('the old password no longer signs in', oldPw.status !== 200,
    `got ${oldPw.status} ${JSON.stringify(oldPw.data)}`)
  const newPwClient = new Client()
  const newPw = await newPwClient.req('/sign-in/email',
    { email: `exit-staff@${DOMAIN}`, password: NEWPW })
  ok('the new password does', newPw.status === 200 && !!newPw.data?.user,
    `got ${newPw.status} ${JSON.stringify(newPw.data)}`)

  // 9e. Self-deactivation, forged from ANOTHER staff member's page with the
  // userId swapped -- the point is that the server refuses it, not that the
  // owner's own page hides the card (a client can post any userId it likes).
  const selfAttempt = await submitForm(exitOwner.jar, `/staff/${exitStaffId}`,
    'Nonaktifkan staf</button>', { userId: exitOwnerRow.user_id })
  ok('an owner cannot deactivate themselves (spec 7.9)',
    selfAttempt.status === 200 && selfAttempt.html.includes(SELF_MSG),
    `got ${selfAttempt.status}`)
  ok('and they are still active',
    await activeOf(exitOwnerRow.user_id, exitOrgId) === true)
  const ownSelfPage = await getPage(exitOwner.jar, `/staff/${exitOwnerRow.user_id}`)
  ok('and their own detail page does not offer the status card at all',
    !ownSelfPage.html.includes('Nonaktifkan staf</button>'))

  // 9g. Handing an admin the owner's password hands them the owner's account.
  const madeExitAdmin = await exitOwner.req('/staff',
    { name: 'SC Exit Admin', email: `exit-admin@${DOMAIN}`, password: PW, role: 'admin' },
    'POST', APP)
  ok('exit admin provisioned', madeExitAdmin.status === 201,
    `got ${madeExitAdmin.status} ${JSON.stringify(madeExitAdmin.data)}`)
  const exitAdminClient = new Client()
  await exitAdminClient.req('/sign-in/email', { email: `exit-admin@${DOMAIN}`, password: PW })
  const adminResetsOwner = await submitForm(exitAdminClient.jar, `/staff/${exitOwnerRow.user_id}`,
    'name="password"', { userId: exitOwnerRow.user_id, password: NEWPW })
  ok('an admin cannot reset the owner\'s password',
    adminResetsOwner.status === 200
      && adminResetsOwner.html.includes('Hanya pemilik yang dapat mengatur ulang kata sandi pemilik.'),
    `got ${adminResetsOwner.status}`)
  const ownerStillSignsIn = await new Client().req('/sign-in/email',
    { email: `exit-owner@${DOMAIN}`, password: PW })
  ok('and the owner\'s own password is untouched', ownerStillSignsIn.status === 200)

  // 9h. lib/session.ts. The row is flipped in SQL, NOT through the action, so
  // no session is revoked -- this is the guard, not the revocation, and it is
  // the only way to reach it.
  await pool.query(
    `update staff_profiles set active = false where user_id = $1 and organization_id = $2`,
    [exitStaffId, exitOrgId])
  const deadPage = await fetch(`${ORIGIN}/dashboard`, {
    headers: { cookie: cookieOf(newPwClient.jar) }, redirect: 'manual',
  })
  ok('a deactivated member on a live cookie is bounced off pages to /login',
    deadPage.status === 307 && (deadPage.headers.get('location') ?? '').includes('/login'),
    `got ${deadPage.status} ${deadPage.headers.get('location')}`)
  const deadApi = await fetch(`${ORIGIN}/api/me/entitlements`, {
    headers: { cookie: cookieOf(newPwClient.jar) },
  })
  ok('and the throwing guard refuses them with 401',
    deadApi.status === 401, `got ${deadApi.status} ${JSON.stringify(await deadApi.json())}`)

  // 9i. The last owner. A salon that can be left ownerless has no recovery
  // short of a database edit.
  const ownersOwner = new Client()
  await ownersOwner.req('/sign-up/email',
    { name: 'SC Owners Owner', email: `owners-owner@${DOMAIN}`, password: PW })
  await pool.query(`update users set email_verified = true where email = $1`,
    [`owners-owner@${DOMAIN}`])
  await ownersOwner.req('/sign-in/email', { email: `owners-owner@${DOMAIN}`, password: PW })
  const ownersOrg = await ownersOwner.req('/organization/create',
    { name: 'Staff Check Owners', slug: 'staffcheck-owners' })
  const ownersOrgId = ownersOrg.data?.id
  await ownersOwner.req('/organization/set-active', { organizationId: ownersOrgId })
  await pool.query(`
    update subscriptions set plan_id = (select id from plans where key = 'business')
     where organization_id = $1`, [ownersOrgId])
  const { rows: [ownersOwnerRow] } = await pool.query(
    `select user_id from members where organization_id = $1 and role = 'owner'`, [ownersOrgId])

  // A second owner, raw -- the trigger seeds the profile, exactly as an
  // invitation accepted into the owner role would.
  await pool.query(`
    insert into users (id, name, email, email_verified, created_at, updated_at)
    values ('sc_owner2', 'SC Owner Two', $1, true, now(), now())`, [`owner2@${DOMAIN}`])
  await pool.query(`
    insert into members (id, user_id, organization_id, role, created_at)
    values ('sc_m_owner2', 'sc_owner2', $1, 'owner', now())`, [ownersOrgId])
  ok('the second owner has an active profile',
    await activeOf('sc_owner2', ownersOrgId) === true)

  const madeOwnersAdmin = await ownersOwner.req('/staff',
    { name: 'SC Owners Admin', email: `owners-admin@${DOMAIN}`, password: PW, role: 'admin' },
    'POST', APP)
  ok('owners admin provisioned', madeOwnersAdmin.status === 201,
    `got ${madeOwnersAdmin.status} ${JSON.stringify(madeOwnersAdmin.data)}`)
  const ownersAdminClient = new Client()
  await ownersAdminClient.req('/sign-in/email', { email: `owners-admin@${DOMAIN}`, password: PW })

  // While TWO owners are active, deactivating one is allowed. Without this the
  // refusal below would pass just as well against a rule that simply never
  // lets an owner go.
  const dropSecond = await submitForm(ownersAdminClient.jar, `/staff/sc_owner2`,
    'Nonaktifkan staf</button>', { userId: 'sc_owner2' })
  ok('with two owners active, one of them can be deactivated',
    dropSecond.status === 200 && await activeOf('sc_owner2', ownersOrgId) === false
      && !dropSecond.html.includes(LAST_OWNER_MSG),
    `got ${dropSecond.status}`)

  const dropLast = await submitForm(ownersAdminClient.jar, `/staff/${ownersOwnerRow.user_id}`,
    'Nonaktifkan staf</button>', { userId: ownersOwnerRow.user_id })
  ok('the last active owner cannot be deactivated (spec 7.8)',
    dropLast.status === 200 && dropLast.html.includes(LAST_OWNER_MSG),
    `got ${dropLast.status}`)
  ok('and they are still active',
    await activeOf(ownersOwnerRow.user_id, ownersOrgId) === true)

  // 9j. The same rule under real concurrency, from two live connections.
  // The statement is READ OUT OF actions.ts, not copied here: a copy proves
  // the copy. Two admins deactivating two DIFFERENT owners is the case a
  // check-then-act guard passes twice.
  await pool.query(`
    update staff_profiles set active = true, deactivated_at = null
     where user_id = 'sc_owner2' and organization_id = $1`, [ownersOrgId])
  const actionsSrc = readFileSync('app/(app)/staff/actions.ts', 'utf8')
  const sqlStart = actionsSrc.indexOf('with owners as materialized')
  const sqlEnd = actionsSrc.indexOf('returning user_id', sqlStart)
  const deactivateSql = actionsSrc.slice(sqlStart, sqlEnd + 'returning user_id'.length)
    .replaceAll('${organizationId}', '$1').replaceAll('${userId}', '$2')
  ok('the deactivation statement was read out of actions.ts, locking clause and all',
    sqlStart !== -1 && sqlEnd !== -1 && deactivateSql.includes('for update of'),
    deactivateSql.slice(0, 120))

  const c1 = await pool.connect()
  const c2 = await pool.connect()
  let raceA, raceB
  try {
    await c1.query('begin')
    await c2.query('begin')
    // c1 takes the owner lock set and deactivates owner #1, uncommitted.
    raceA = await c1.query(deactivateSql, [ownersOrgId, ownersOwnerRow.user_id])
    // c2 goes for the OTHER owner. It must block on the same lock set rather
    // than reading a stale "2 owners" and writing.
    const pending = c2.query(deactivateSql, [ownersOrgId, 'sc_owner2'])
    let settled = false
    pending.then(() => { settled = true }, () => { settled = true })
    await new Promise((r) => setTimeout(r, 400))
    ok('the second connection blocks instead of reading a stale owner count', !settled)
    await c1.query('commit')
    raceB = await pending
    await c2.query('commit')
  } finally {
    c1.release()
    c2.release()
  }
  ok('one concurrent deactivation succeeds', raceA.rows.length === 1,
    JSON.stringify(raceA.rows))
  ok('the other refuses, having re-read under the lock', raceB.rows.length === 0,
    JSON.stringify(raceB.rows))
  const { rows: [ownersLeft] } = await pool.query(`
    select count(*)::int n from staff_profiles s
      join members m on m.user_id = s.user_id and m.organization_id = s.organization_id
     where s.organization_id = $1 and s.active
       and (string_to_array(m.role, ',') && array['owner'])`, [ownersOrgId])
  ok('and the salon still has an owner', ownersLeft.n >= 1, JSON.stringify(ownersLeft))

  // 9k. spec 7.14, across every fixture this run created.
  const { rows: [pairing] } = await pool.query(`
    select count(*)::int n from staff_profiles s
     where s.team_id is not null
       and not exists (select 1 from team_members tm
                        where tm.user_id = s.user_id and tm.team_id = s.team_id)`)
  ok('every staff_profiles row with a branch has a matching team_members row (spec 7.14)',
    pairing.n === 0, `${pairing.n} unpaired`)
} finally {
  await pool.end()
}

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m`)
process.exit(fail ? 1 : 0)
