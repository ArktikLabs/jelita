import { cache } from 'react'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { auth } from './auth'
import { db } from './db'
import { PlanError } from './plan/entitlements'
import { getBranchStatus } from './plan/branch'
import type { statement } from './permissions'

type Resource = keyof typeof statement
type Permissions = Partial<{ [K in Resource]: (typeof statement)[K][number][] }>

/** Current session, or null. Safe to call in any server component / action. */
export async function getSession() {
  return auth.api.getSession({ headers: await headers() })
}

/**
 * A deactivated staff member must not keep working on a live cookie.
 * Deactivation revokes their sessions, so this is the second line: a session
 * minted in the same instant, or a profile flipped by any other path, still
 * stops here. Checked at the point both guard families converge, so no caller
 * can forget it. Memoised per request -- requireUser alone is reached several
 * times on one page through requireBranch and currentEntitlements.
 *
 * It REVOKES rather than merely reporting, because their credentials still
 * work: signInEmail knows nothing of staff_profiles, so a dismissed employee
 * can sign in again whenever they like. Refusing a still-live cookie is not
 * enough -- app/(auth)/layout.tsx bounces anyone holding a session to
 * /dashboard, so /dashboard and /login would trade the request until the
 * browser gave up, with the sign-out button behind the app layout that never
 * renders. Killing the session removes that contradiction; teaching the auth
 * layout this same check would only paper over it.
 */
const isDeactivated = cache(async (userId: string, organizationId: string | null | undefined) => {
  if (!organizationId) return false
  const { rows } = await db.execute(sql`
    select active from staff_profiles
     where user_id = ${userId} and organization_id = ${organizationId}`)
  if ((rows[0] as { active: boolean } | undefined)?.active !== false) return false
  const ctx = await auth.$context
  await ctx.internalAdapter.deleteUserSessions(userId)
  return true
})

/** Session or throw. Use at the top of any authenticated server action. */
export async function requireUser() {
  const session = await getSession()
  if (!session?.user) throw new Error('UNAUTHORIZED')
  // Their credentials are gone, not their permissions -- 401, not 403.
  if (await isDeactivated(session.user.id, session.session.activeOrganizationId)) {
    throw new Error('UNAUTHORIZED')
  }
  return session
}

/**
 * The active branch (team) for this request. PRD §5.8: every scoped query
 * must filter on this — never trust a branch id from the client.
 *
 * Pass `{ write: true }` for any mutation. Over-cap and closed branches are
 * both read-only, for different reasons — see getBranchStatus.
 */
export async function requireBranch(opts: { write?: boolean } = {}) {
  const session = await requireUser()
  const branchId = session.session.activeTeamId
  if (!branchId) throw new Error('NO_ACTIVE_BRANCH')

  if (opts.write) {
    // getBranchStatus is tenant-scoped in its own statement, so it needs the
    // org. A session with a branch but no organization cannot be written
    // through at all -- the session hook only ever sets activeTeamId
    // alongside its organization (lib/auth.ts).
    const organizationId = session.session.activeOrganizationId
    if (!organizationId) throw new Error('NO_ACTIVE_ORGANIZATION')
    const status = await getBranchStatus(branchId, organizationId)
    // Two read-only reasons, two remedies. An upgrade prompt shown to someone
    // who closed their own branch is the same mistake as conflating 403/402.
    if (status === 'over_cap') throw new PlanError('BRANCH_LOCKED', { branchId })
    if (status === 'closed') throw new Error('BRANCH_CLOSED')
  }

  return {
    ...session,
    branchId,
    organizationId: session.session.activeOrganizationId,
  }
}

/**
 * Permission gate. Throws FORBIDDEN unless the caller's role in the active
 * organization grants every listed action.
 *
 *   await requirePermission({ pos: ['void'] })
 */
export async function requirePermission(permissions: Permissions) {
  const session = await requireUser()
  const { success } = await auth.api.hasPermission({
    headers: await headers(),
    body: { permissions: permissions as Record<string, string[]> },
  })
  if (!success) throw new Error('FORBIDDEN')
  return session
}

/**
 * Page guard: session or bounce to /login.
 *
 * The API-route guards above throw so a handler can map the error to a status
 * code. A page has no status code to return — it redirects. Both read the same
 * session; only the failure behaviour differs.
 */
export async function requirePageSession() {
  const session = await getSession()
  if (!session?.user) redirect('/login')
  // Same refusal as requireUser, in this family's idiom. /login is a client
  // page that does not bounce a signed-in visitor, so this cannot loop.
  if (await isDeactivated(session.user.id, session.session.activeOrganizationId)) {
    redirect('/login')
  }
  return session
}

/** Page guard: permission, or bounce to the dashboard. */
export async function requirePagePermission(permissions: Permissions) {
  const session = await requirePageSession()
  const { success } = await auth.api.hasPermission({
    headers: await headers(),
    body: { permissions: permissions as Record<string, string[]> },
  })
  if (!success) redirect('/dashboard')
  return session
}

/** Page guard: an active organization, or bounce to onboarding. */
export async function requirePageOrg() {
  const session = await requirePageSession()
  const organizationId = session.session.activeOrganizationId
  if (!organizationId) redirect('/dashboard/onboarding')
  return { ...session, organizationId }
}
