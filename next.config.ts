import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // The e2e suite builds and serves the app on its own port against the
  // disposable database. Next's dev-server lock is scoped to the output
  // directory, so without a separate distDir an e2e run and a running
  // `pnpm dev` fight over .next -- Next refuses the second one outright.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
}

export default nextConfig
