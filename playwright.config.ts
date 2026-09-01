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
    // `next dev` with its own output directory. Next's dev lock is scoped to
    // distDir, not to the port, so this coexists with a dev server on 3001 --
    // which is why a production build was needed before .next-e2e existed.
    //
    // Dev mode also turns better-auth's rate limiting off (its default is
    // production-only). That matters more than it sounds: the limits are
    // process-wide and in-memory, the spec files together exceeded the 5/hour
    // sign-up and 10/min sign-in budgets, and the symptom was one file failing
    // with a 429 caused by a DIFFERENT file. No test asserts rate-limit
    // behaviour, so nothing is lost by disabling it -- but a suite that ever
    // wants to would need a production-mode server of its own.
    //
    // The cost, stated plainly: e2e no longer exercises the production build.
    // The shell suites it replaces never did either, so this is not a
    // regression -- but a production-mode run belongs in CI eventually.
    command: `NEXT_DIST_DIR=.next-e2e pnpm dev --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      DIRECT_URL: TEST_DATABASE_URL,
      BETTER_AUTH_URL: BASE_URL,
      NEXT_DIST_DIR: '.next-e2e',
    },
  },
})
