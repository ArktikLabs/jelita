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
const ORIGIN = process.env.BETTER_AUTH_URL
const DOMAIN = 'svccheck.local'
const PW = 'demo12345'

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
  const { formatMoney, parseMoney } = await import('../lib/money.ts')
  ok('IDR has no minor digits', formatMoney(150000, 'IDR').includes('150.000'))
  ok('USD has two', formatMoney(15050, 'USD') === '$150.50', formatMoney(15050, 'USD'))
  ok('IDR parses whole units', parseMoney('150000', 'IDR') === 150000)
  ok('USD parses to cents', parseMoney('150.50', 'USD') === 15050,
     String(parseMoney('150.50', 'USD')))
  ok('a negative amount is refused', parseMoney('-5', 'IDR') === null)
} finally {
  await pool.end()
}

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m`)
process.exit(fail ? 1 : 0)
