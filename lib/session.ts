import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from './auth'
import { PlanError } from './plan/entitlements'
import { isBranchActive } from './plan/branch'
import type { statement } from './permissions'

type Resource = keyof typeof statement
type Permissions = Partial<{ [K in Resource]: (typeof statement)[K][number][] }>

/** Current session, or null. Safe to call in any server component / action. */
export async function getSession() {
  return auth.api.getSession({ headers: await headers() })
}

/** Session or throw. Use at the top of any authenticated server action. */
export async function requireUser() {
  const session = await getSession()
  if (!session?.user) throw new Error('UNAUTHORIZED')
  return session
}

/**
 * The active branch (team) for this request. PRD §5.8: every scoped query
 * must filter on this — never trust a branch id from the client.
 *
 * Pass `{ write: true }` for any mutation. Locked branches (over the tier's
 * cap) are read-only.
 */
export async function requireBranch(opts: { write?: boolean } = {}) {
  const session = await requireUser()
  const branchId = session.session.activeTeamId
  if (!branchId) throw new Error('NO_ACTIVE_BRANCH')

  if (opts.write && !(await isBranchActive(branchId))) {
    throw new PlanError('BRANCH_LOCKED', { branchId })
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
  return session
}

/** Page guard: an active organization, or bounce to onboarding. */
export async function requirePageOrg() {
  const session = await requirePageSession()
  const organizationId = session.session.activeOrganizationId
  if (!organizationId) redirect('/onboarding')
  return { ...session, organizationId }
}
