/**
 * Customer checks. No framework on purpose.
 *   pnpm customer:check      (dev server must be running for later sections)
 */
import { Pool } from 'pg'

let pass = 0, fail = 0
const ok = (n, c, d) => (c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${n}`))
                           : (fail++, console.log(`  \x1b[31m✗\x1b[0m ${n}  ${d ?? ''}`)))
const head = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`)

const pool = new Pool({ connectionString: process.env.DIRECT_URL })
const ORG = 'custcheck_org'
const ORG2 = 'custcheck_org2'
const DOMAIN = 'custcheck.local'

try {
  head('0. reset test fixtures')
  // Unconditional, at the START of every run: later sections reuse fixtures
  // created by earlier ones, so cleanup never happens mid-run (a crash would
  // poison the next run) or at a section's end (a later section needs the row).
  await pool.query(`delete from organizations where slug like 'custcheck%'`)
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`])
  ok('cleared', true)

  head('1. schema')
  const { rows: idx } = await pool.query(`
    select indexname from pg_indexes where tablename = 'customers'`)
  ok('the partial phone index exists',
     idx.some((r) => r.indexname === 'customers_org_phone_key'))
  const { rows: [rls] } = await pool.query(`
    select relrowsecurity from pg_class where relname = 'customers'`)
  ok('RLS enabled', rls.relrowsecurity === true)

  head('2. normalisation')
  const { normalizePhone } = await import('../lib/phone.ts')
  const spellings = ['0812345678', '+62 812 345 678', '62812345678', '0812-3456-78']
  ok('every spelling of one number normalises alike',
     new Set(spellings.map(normalizePhone)).size === 1,
     JSON.stringify(spellings.map(normalizePhone)))
  ok('a mistyped 62-plus-0 prefix folds too', normalizePhone('620812345678') === '62812345678')
  ok('input with no digits is refused', normalizePhone('abc') === null && normalizePhone('') === null)

  head('3. one customer per number per salon')
  await pool.query(`
    insert into organizations (id, name, slug, created_at)
    values ($1, 'Cust Check', 'custcheck', now()), ($2, 'Cust Check 2', 'custcheck2', now())`,
    [ORG, ORG2])
  const add = (id, org, name, phone, key) => pool.query(`
    insert into customers (id, organization_id, name, phone, phone_key)
    values ($1, $2, $3, $4, $5)`, [id, org, name, phone, key])

  await add('cc_1', ORG, 'Dewi', '0812345678', '62812345678')
  let refused = false
  try { await add('cc_2', ORG, 'Dewi Lagi', '+62812345678', '62812345678') }
  catch { refused = true }
  ok('a second customer with the same number is refused', refused)

  // A salon may hold any number of customers with no phone. This works because
  // Postgres treats NULLs as distinct in a unique index -- the index being
  // partial is a size optimisation, not the reason. Asserted because the
  // BEHAVIOUR is what the walk-in case depends on, whatever enforces it.
  await add('cc_3', ORG, 'Walk-in Satu', null, null)
  let secondNullOk = true
  try { await add('cc_4', ORG, 'Walk-in Dua', null, null) }
  catch { secondNullOk = false }
  ok('two customers with no phone both save', secondNullOk)

  // Uniqueness is per salon, not global -- another salon's customer may share
  // the number without colliding.
  let otherSalonOk = true
  try { await add('cc_5', ORG2, 'Dewi Salon Lain', '0812345678', '62812345678') }
  catch { otherSalonOk = false }
  ok('another salon may hold the same number', otherSalonOk)
} finally {
  await pool.end()
}

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m`)
process.exit(fail ? 1 : 0)
