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

try {
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
  const mkTeam = (n, i) => pool.query(
    `insert into teams (id, name, organization_id, created_at)
     values ($1, $2, 'plancheck_org', now() + ($3 || ' seconds')::interval)`,
    [`plancheck_t${i}`, n, i])
  for (let i = 1; i <= 3; i++) await mkTeam(`Branch ${i}`, i)

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

  await pool.query(`update subscriptions set status = 'canceled'
                     where organization_id = 'plancheck_org'`)
  const { rows: cancelled } = await pool.query(`
    select plan_id from effective_plan where organization_id = 'plancheck_org'`)
  const { rows: def } = await pool.query(`select id from plans where is_default`)
  ok('canceled resolves to the default plan',
    String(cancelled[0].plan_id) === String(def[0].id),
    JSON.stringify({ cancelled, def }))

  await pool.query(`update subscriptions set status = 'past_due'
                     where organization_id = 'plancheck_org'`)
  const { rows: pastDue } = await pool.query(`
    select plan_id from effective_plan where organization_id = 'plancheck_org'`)
  const { rows: subPlan } = await pool.query(`
    select plan_id from subscriptions where organization_id = 'plancheck_org'`)
  ok('past_due retains the subscription plan, unchanged',
    String(pastDue[0].plan_id) === String(subPlan[0].plan_id),
    JSON.stringify({ pastDue, subPlan }))

  await pool.query(`delete from organizations where id = 'plancheck_org'`)
  await pool.query(`delete from plan_limits
                     where plan_id = (select id from plans where is_default)
                       and resource = 'branches'`)
} catch (e) {
  fail++
  console.error('\n\x1b[31mFATAL\x1b[0m', e.stack)
} finally {
  await pool.end()
}

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`)
process.exit(fail ? 1 : 0)
