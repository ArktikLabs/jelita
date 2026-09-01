import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['./tests/global-setup.ts'],
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
