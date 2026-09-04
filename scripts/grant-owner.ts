import { Pool } from 'pg'
import { createLocalAccountIssuer } from 'better-auth/db'
import { auth } from '../lib/auth'

/**
 * Give a real person owner access to the seeded demo salon.
 *
 * The demo seed builds one owner (owner@ovarya.demo) whose password is
 * published in the runbook. This adds a SECOND owner with an address someone
 * actually reads, so the demo can be driven from a real account without
 * handing out the shared one.
 *
 * Re-run it after `pnpm seed:demo`: seeding deletes the organization and every
 * membership with it.
 *
 *   pnpm exec tsx --env-file=.env.local scripts/grant-owner.ts <email> [password]
 *
 * Idempotent. An existing login keeps its password unless a new one is given.
 */
const SLUG = process.env.DEMO_SLUG ?? 'ovarya'

async function main() {
  const [email, password] = process.argv.slice(2)
  if (!email) throw new Error('usage: grant-owner.ts <email> [password]')
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required')

  const pool = new Pool({ connectionString: url })
  const ctx = await auth.$context

  const { rows: [org] } = await pool.query(
    `select id, name from organizations where slug = $1`, [SLUG])
  if (!org) throw new Error(`no salon with slug "${SLUG}" — run pnpm seed:demo first`)

  const { rows: [existing] } = await pool.query(
    `select id from users where lower(email) = lower($1)`, [email])

  let userId: string
  if (existing) {
    userId = existing.id
    // Verified, always: without a mail transport an unverified account cannot
    // sign in and cannot ask for a new link either.
    await pool.query(`update users set email_verified = true where id = $1`, [userId])
    if (password) {
      await pool.query(
        `update accounts set password = $1 where user_id = $2 and provider_id = 'credential'`,
        [await ctx.password.hash(password), userId])
    }
  } else {
    if (!password) throw new Error('a new login needs a password: grant-owner.ts <email> <password>')
    const user = await ctx.internalAdapter.createUser(
      { email, name: email.split('@')[0], emailVerified: true },
      { method: 'email-password' })
    await ctx.internalAdapter.linkAccount({
      userId: user.id,
      providerId: 'credential',
      issuer: createLocalAccountIssuer('credential'),
      accountId: user.id,
      password: await ctx.password.hash(password),
    })
    userId = user.id
  }

  // The membership. Inserting `members` seeds staff_profiles by trigger.
  //
  // Checked rather than `on conflict`: better-auth's members table has no
  // unique constraint on (user_id, organization_id) -- only a primary key on
  // id -- so a conflict target would error and a bare `do nothing` would
  // happily write a duplicate membership.
  const { rows: [member] } = await pool.query(
    `select id, role from members where user_id = $1 and organization_id = $2`,
    [userId, org.id])
  if (member) {
    await pool.query(`update members set role = 'owner' where id = $1`, [member.id])
  } else {
    await pool.query(
      `insert into members (id, user_id, organization_id, role, created_at)
       values ($1, $2, $3, 'owner', now())`, [crypto.randomUUID(), userId, org.id])
  }

  // Make this salon the one a fresh session lands on.
  //
  // lib/auth.ts's session hook activates the OLDEST membership as a
  // deterministic tiebreak, and the UI switches BRANCHES only -- nothing calls
  // setActiveOrganization outside onboarding. So a user who already belongs to
  // an older salon signs in there and cannot reach this one at all.
  //
  // Backdating this membership is the lever available without deleting the
  // other salon or inventing a "preferred organization" the product does not
  // have. The honest fix is an organization switcher; until then this is what
  // makes the demo reachable for someone with a pre-existing account.
  const { rows: [older] } = await pool.query(
    `select min(created_at) as at from members
      where user_id = $1 and organization_id <> $2`, [userId, org.id])
  if (older?.at) {
    await pool.query(
      `update members set created_at = $1::timestamptz - interval '1 second'
        where user_id = $2 and organization_id = $3`, [older.at, userId, org.id])
    console.log('  note: backdated this membership so a fresh session lands here,')
    console.log('        not on an older salon this account already belongs to')
  }

  // AND a team_members row, which is what lib/auth.ts's session hook reads to
  // set activeTeamId. Without it you sign in with no active branch and every
  // branch-scoped screen -- the dashboard included -- renders empty. That
  // exact bug shipped once in the seed and was only found by screenshotting.
  const { rows: [team] } = await pool.query(
    `select id, name from teams where organization_id = $1 order by created_at limit 1`,
    [org.id])
  const { rows: [seat] } = await pool.query(
    `select id from team_members where team_id = $1 and user_id = $2`, [team.id, userId])
  if (!seat) {
    await pool.query(
      `insert into team_members (id, team_id, user_id, created_at) values ($1, $2, $3, now())`,
      [crypto.randomUUID(), team.id, userId])
  }

  console.log(`  ${email} is now an owner of ${org.name}`)
  console.log(`  active branch: ${team.name}`)
  console.log(`  password: ${password ? 'set' : 'unchanged'}`)
  await pool.end()
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
