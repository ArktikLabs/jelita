import { execFileSync } from 'node:child_process'
import { Client } from 'pg'
import { TEST_DATABASE_URL } from './db'

/**
 * Drop and rebuild the schema, then migrate and seed.
 *
 * The container is called disposable, but nothing enforced it: it stays up
 * across runs, so fixtures from every previous run accumulated. Each spec
 * file's own cleanup then had to cascade-delete through a dozen tables, and
 * once enough runs had piled up a `delete from organizations` blew a 30s
 * beforeAll timeout and a whole spec file was skipped -- while the run took
 * 16 minutes instead of under one.
 *
 * Dropping the schema costs a second on an empty database and makes every run
 * start from the same state, which is the property the whole design was for.
 */
export async function resetDatabase() {
  const client = new Client({ connectionString: TEST_DATABASE_URL })
  await client.connect()
  // Drops the drizzle journal too, so migrations re-run in full and the schema
  // can never drift from the migration files.
  await client.query('drop schema if exists public cascade')
  await client.query('create schema public')
  await client.query('drop schema if exists drizzle cascade')
  await client.end()

  const env = {
    ...process.env,
    DIRECT_URL: TEST_DATABASE_URL,
    DATABASE_URL: TEST_DATABASE_URL,
  }
  execFileSync('pnpm', ['exec', 'drizzle-kit', 'migrate'], { stdio: 'inherit', env })
  execFileSync('node', ['scripts/seed-plans.mjs'], { stdio: 'inherit', env })
}
