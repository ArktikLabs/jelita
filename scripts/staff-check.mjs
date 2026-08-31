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
} finally {
  await pool.end()
}

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m`)
process.exit(fail ? 1 : 0)
