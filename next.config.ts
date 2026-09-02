import type { NextConfig } from 'next'

/**
 * The apex a salon's subdomain hangs off: `ovarya.<apex>/book`.
 *
 * One env var so dev, the e2e run and production share ONE rule rather than
 * three that can drift.
 *
 * The PORT IS STRIPPED, and that is not cosmetic: Next matches `type: 'host'`
 * against `host.split(':', 1)[0]`
 * (next/dist/shared/lib/router/utils/prepare-destination.js), so an apex
 * carrying `:3100` can never match and the rewrite silently never fires --
 * the page still answers on /book/<slug>, so the symptom is a subdomain that
 * 404s while everything else looks fine. Verified by reading that source
 * after watching it not fire.
 */
const APEX = (process.env.NEXT_PUBLIC_APEX_HOST ?? 'localhost')
  .split(':')[0]
  .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const nextConfig: NextConfig = {
  // The e2e suite builds and serves the app on its own port against the
  // disposable database. Next's dev-server lock is scoped to the output
  // directory, so without a separate distDir an e2e run and a running
  // `pnpm dev` fight over .next -- Next refuses the second one outright.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',

  async rewrites() {
    // beforeFiles, not a bare array. A returned ARRAY is afterFiles, which
    // runs AFTER filesystem routes -- so `/` on a tenant subdomain matched
    // app/page.tsx (the marketing page) and never reached the rewrite, while
    // `/book` worked because no page owns that path. The host condition scopes
    // both rules to tenant subdomains, so the apex is untouched either way.
    return { beforeFiles: [
      // ovarya.example.com/book -> /book/ovarya, so the tenant arrives as an
      // ordinary route param on app/book/[salon].
      //
      // A rewrite rather than proxy.ts: Next 16's proxy reference warns that
      // Server Functions are POSTs to the route they live on, so a matcher
      // change or a moved action can silently remove proxy coverage. A guard a
      // refactor can delete is worse than none, because it reads as one. The
      // hostname only says which salon to LOOK UP -- lib/salon.ts validates,
      // and every page and action calls it.
      {
        source: '/book',
        has: [{ type: 'host', value: `(?<salon>[^.]+)\\.${APEX}` }],
        destination: '/book/:salon',
      },
      // The bare subdomain is the nicest link a salon can hand out.
      {
        source: '/',
        has: [{ type: 'host', value: `(?<salon>[^.]+)\\.${APEX}` }],
        destination: '/book/:salon',
      },
    ], afterFiles: [], fallback: [] }
  },
}

export default nextConfig
