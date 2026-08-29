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
} catch (e) {
  fail++
  console.error('\n\x1b[31mFATAL\x1b[0m', e.stack)
} finally {
  await pool.end()
}

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`)
process.exit(fail ? 1 : 0)
