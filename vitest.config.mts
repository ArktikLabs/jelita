import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['./tests/global-setup.ts'],
    // Point the app's own pool (lib/pg-pool.ts reads DATABASE_URL) at the
    // disposable container, so a suite can import lib/* and exercise the real
    // module instead of re-implementing its statements. Scoped to the Vitest
    // environment; nothing outside the run sees it.
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL
        ?? 'postgres://jelita:jelita@127.0.0.1:55432/jelita_test',
    },
    // Files run sequentially for now: the suites still share one database, so
    // two files creating fixtures at once would interleave. Once every suite
    // stops mutating shared rows this becomes `threads` and the wall clock
    // drops to the slowest file rather than the sum.
    fileParallelism: false,
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
})
