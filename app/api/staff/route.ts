import { APIError } from 'better-auth/api'
import { requirePermission } from '@/lib/session'
import { roles, type SalonRole } from '@/lib/permissions'
import { PlanError } from '@/lib/plan/entitlements'
import { provisionStaff } from '@/lib/staff'

const STATUS: Record<string, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NO_ACTIVE_ORGANIZATION: 409,
  ORGANIZATION_NOT_FOUND: 409,
  EMAIL_TAKEN: 409,
  // provisionStaff throws this for a deactivated branch (lib/staff.ts);
  // BRANCH_LOCKED (over-cap) is a PlanError, already mapped to 402 above.
  BRANCH_CLOSED: 409,
}

/**
 * Provision a staff login without an email round-trip.
 *
 * PRD §3 staff are onboarded at the front desk — many therapists have no
 * working email. This is the tenant-scoped alternative to better-auth's admin
 * plugin (whose roles are global): the caller needs `staff:create` in their
 * ACTIVE organization, and the new member can only land in that organization.
 */
export async function POST(req: Request) {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'INVALID_JSON' }, { status: 400 })
  }

  const { name, email, password, role, branchId } = body as Record<string, string>
  if (!name || !email || !password) {
    return Response.json({ error: 'MISSING_FIELDS' }, { status: 400 })
  }
  if (!(role in roles)) {
    return Response.json({ error: 'UNKNOWN_ROLE' }, { status: 400 })
  }

  try {
    const session = await requirePermission({ staff: ['create'] })
    const organizationId = session.session.activeOrganizationId
    if (!organizationId) throw new Error('NO_ACTIVE_ORGANIZATION')

    const { user } = await provisionStaff({
      organizationId,
      name,
      email,
      password,
      role: role as SalonRole,
      teamId: branchId,
    })

    return Response.json({ user }, { status: 201 })
  } catch (e) {
    if (e instanceof PlanError) {
      return Response.json({ error: e.code, ...e.meta }, { status: 402 })
    }
    // provisionStaff calls better-auth's own addMember/addTeamMember, which
    // throw APIError, not a plain Error whose .message is one of our own
    // codes -- .message on an APIError is a human sentence ("You are not
    // allowed..."), so it would never hit the STATUS lookup below and would
    // always fall through to the generic 400 default. .statusCode is the
    // numeric code better-call derives from the string .status (see
    // app/(app)/branches/actions.ts for the same 402 case) -- use it
    // directly so a FORBIDDEN from addTeamMember reports 403, not 400.
    if (e instanceof APIError) {
      return Response.json({ error: e.status }, { status: e.statusCode })
    }
    const msg = e instanceof Error ? e.message : 'ERROR'
    return Response.json({ error: msg }, { status: STATUS[msg] ?? 400 })
  }
}
