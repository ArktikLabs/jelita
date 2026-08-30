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

try {
  head('0. reset test fixtures')
  // Unconditional, at the START of every run: later sections in this file
  // reuse fixtures created by earlier sections, so cleanup never happens
  // mid-run (a crash would poison the next run) or at a section's end (a
  // later section still needs the row).
  await pool.query(`delete from organizations where id = any($1)`, [[ORG, ORG2]])
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
} catch (e) {
  fail++
  console.error('\n\x1b[31mFATAL\x1b[0m', e.stack)
} finally {
  await pool.end()
}

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`)
process.exit(fail ? 1 : 0)
