import { defineConfig } from '@playwright/test'
import { TEST_DATABASE_URL } from './tests/db'

const PORT = 3100
const BASE_URL = `http://localhost:${PORT}`

/**
 * End-to-end specs run the real app against the disposable Postgres, on their
 * own port so a dev server on 3001 is untouched.
 *
 * Workers stay at 1 for now: the app is multi-tenant but the suites still
 * share one database, and better-auth's rate limiting is keyed on the client
 * address, so parallel workers would collect 429s that look like real bugs.
 */
export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  workers: 1,
  fullyParallel: false,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  webServer: {
    // A production build, not `next dev`: Next's dev lock is scoped to the
    // output directory, so a dev server already running on 3001 would block
    // this one. Building to .next-e2e keeps the two entirely separate, and
    // testing the production output is closer to what ships anyway.
    command: `NEXT_DIST_DIR=.next-e2e pnpm build && NEXT_DIST_DIR=.next-e2e pnpm start --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      DIRECT_URL: TEST_DATABASE_URL,
      BETTER_AUTH_URL: BASE_URL,
      NEXT_DIST_DIR: '.next-e2e',
    },
  },
})
