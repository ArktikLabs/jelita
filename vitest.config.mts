import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // The same `@/` the app and tsconfig use. Without it a test importing a
  // component fails to COLLECT -- "Cannot find package '@/lib/utils'" -- which
  // reports as "no tests" rather than as a failure, so the file looks like it
  // passed.
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
  test: {
    globalSetup: ['./tests/global-setup.ts'],
    // Point the app's own pool (lib/pg-pool.ts reads DATABASE_URL) at the
    // disposable container, so a suite can import lib/* and exercise the real
    // module instead of re-implementing its statements. Scoped to the Vitest
    // environment; nothing outside the run sees it.
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL
        ?? 'postgres://jelita:jelita@127.0.0.1:55432/jelita_test',
      // Same disposable MinIO, same reason.
      S3_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:59000',
      S3_BUCKET: process.env.S3_BUCKET ?? 'jelita-assets',
      S3_ACCESS_KEY: process.env.S3_ACCESS_KEY ?? 'jelita',
      S3_SECRET_KEY: process.env.S3_SECRET_KEY ?? 'jelitajelita',
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
