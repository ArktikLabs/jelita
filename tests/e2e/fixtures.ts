import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { request } from '@playwright/test'
import type { Pool } from 'pg'

export const BASE_URL = 'http://localhost:3100'

/**
 * A request context with its own cookie jar that never follows redirects --
 * many assertions here are ABOUT the redirect.
 *
 * The Origin header is not optional: better-auth's CSRF check rejects a
 * state-changing call without one (MISSING_OR_NULL_ORIGIN, 403). A browser
 * sends it automatically; a request context does not.
 */
export const client = () => request.newContext({
  maxRedirects: 0,
  extraHTTPHeaders: { origin: BASE_URL },
})

let hashPassword: ((password: string) => Promise<string>) | undefined

/**
 * better-auth's own password hasher.
 *
 * `@better-auth/utils` is better-auth's dependency, not ours, so it is
 * resolved relative to better-auth's install location -- pnpm does not hoist
 * nested dependencies, and adding it to our package.json would pin a version
 * better-auth is free to change.
 *
 * Loaded lazily rather than at module scope: Playwright transforms spec files
 * to CommonJS, which supports neither top-level await nor import.meta.
 */
export function loadHasher() {
  if (hashPassword) return hashPassword
  const req = createRequire(__filename)
  const resolved = createRequire(req.resolve('better-auth'))
    .resolve('@better-auth/utils/password')
  hashPassword = req(resolved).hashPassword as (p: string) => Promise<string>
  return hashPassword
}

/**
 * Create a verified login WITHOUT spending sign-up budget.
 *
 * lib/auth.ts rate-limits /sign-up/email to 5 per hour and /sign-in/email to
 * 10 per minute, process-wide. That budget is shared by every e2e spec file,
 * the limiter is in-memory rather than DB-backed -- so tearing the database
 * down does not reset it -- and the suites already sum to the whole
 * allowance. A spec that signs up naively does not fail on its own; it makes
 * some OTHER file fail with a 429 that looks like a real bug.
 *
 * So: insert the user and a real credential account directly, hashed with
 * better-auth's own hasher, then sign in normally. Sign-in has room; sign-up
 * does not.
 *
 * Specs whose SUBJECT is the sign-up endpoint itself should call it directly
 * instead -- that is the thing under test, and it should spend the budget.
 */
export async function createLogin(
  pool: Pool,
  { name, email, password }: { name: string; email: string; password: string },
): Promise<string> {
  const hash = loadHasher()
  const id = randomUUID()
  await pool.query(`
    insert into users (id, name, email, email_verified, created_at, updated_at)
    values ($1, $2, $3, true, now(), now())`, [id, name, email])
  await pool.query(`
    insert into accounts
      (id, account_id, provider_id, issuer, user_id, password, created_at, updated_at)
    values ($1, $2, 'credential', 'local:credential', $2, $3, now(), now())`,
    [randomUUID(), id, await hash(password)])
  return id
}

/** Sign in an existing login and return its context. */
export async function signIn(email: string, password: string) {
  const ctx = await client()
  const res = await ctx.post('/api/auth/sign-in/email', { data: { email, password } })
  if (res.status() !== 200) {
    throw new Error(`sign-in failed for ${email}: ${res.status()} ${await res.text()}`)
  }
  return ctx
}

/**
 * A salon owned by a freshly created login, with the org active on the
 * session. Returns the context, the owner's user id and the organization id.
 *
 * Sign in happens AFTER any membership row exists, because lib/auth.ts
 * resolves activeOrganizationId when the session is created -- signing in
 * first yields a session with no active org, and every guarded page then
 * redirects regardless of permission, which looks exactly like a
 * permissions bug.
 */
export async function createSalon(
  pool: Pool,
  { name, email, password, salon, slug }:
    { name: string; email: string; password: string; salon: string; slug: string },
) {
  const userId = await createLogin(pool, { name, email, password })
  const ctx = await signIn(email, password)
  const created = await ctx.post('/api/auth/organization/create', { data: { name: salon, slug } })
  if (created.status() !== 200) {
    throw new Error(`org create failed: ${created.status()} ${await created.text()}`)
  }
  const organizationId = (await created.json()).id as string
  await ctx.post('/api/auth/organization/set-active', { data: { organizationId } })
  return { ctx, userId, organizationId }
}
