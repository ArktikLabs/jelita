import { execFileSync } from 'node:child_process'
import { TEST_DATABASE_URL } from './db'

/**
 * Bring the disposable database to the state the app expects, once per run.
 *
 * Migrations use the same files the real database runs -- not a separate
 * schema definition that could drift from them -- and the plan seed has to
 * follow, because creating an organization fires a trigger that subscribes it
 * to the default plan. Without a seeded default, every fixture that creates a
 * salon fails with "no default plan configured".
 */
export default function setup() {
  const env = {
    ...process.env,
    DIRECT_URL: TEST_DATABASE_URL,
    DATABASE_URL: TEST_DATABASE_URL,
  }
  execFileSync('pnpm', ['exec', 'drizzle-kit', 'migrate'], { stdio: 'inherit', env })
  execFileSync('node', ['scripts/seed-plans.mjs'], { stdio: 'inherit', env })
}
