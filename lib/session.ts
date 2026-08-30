import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from './auth'
import { PlanError } from './plan/entitlements'
import { getBranchStatus } from './plan/branch'
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
 * Pass `{ write: true }` for any mutation. Over-cap and closed branches are
 * both read-only, for different reasons — see getBranchStatus.
 */
export async function requireBranch(opts: { write?: boolean } = {}) {
  const session = await requireUser()
  const branchId = session.session.activeTeamId
  if (!branchId) throw new Error('NO_ACTIVE_BRANCH')

  if (opts.write) {
    const status = await getBranchStatus(branchId)
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
  if (!organizationId) redirect('/onboarding')
  return { ...session, organizationId }
}
