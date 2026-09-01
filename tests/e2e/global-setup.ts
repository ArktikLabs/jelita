import { execFileSync } from 'node:child_process'
import { TEST_DATABASE_URL } from '../db'

/**
 * Same shape as the Vitest global setup: the real migration files and the real
 * plan seed, so the e2e schema cannot drift from production. The seed is not
 * optional -- creating an organization fires a trigger that subscribes it to
 * the default plan.
 */
export default function globalSetup() {
  const env = {
    ...process.env,
    DIRECT_URL: TEST_DATABASE_URL,
    DATABASE_URL: TEST_DATABASE_URL,
  }
  execFileSync('pnpm', ['exec', 'drizzle-kit', 'migrate'], { stdio: 'inherit', env })
  execFileSync('node', ['scripts/seed-plans.mjs'], { stdio: 'inherit', env })
}
