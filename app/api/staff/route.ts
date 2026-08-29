import { createLocalAccountIssuer } from 'better-auth'
import { auth } from '@/lib/auth'
import { requirePermission } from '@/lib/session'
import { roles, type SalonRole } from '@/lib/permissions'
import { PlanError, requireQuota } from '@/lib/plan/entitlements'

const STATUS: Record<string, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NO_ACTIVE_ORGANIZATION: 409,
  EMAIL_TAKEN: 409,
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
    await requireQuota('staff')

    // Create the login directly instead of via signUpEmail: that endpoint
    // mints a session, and nextCookies() would then write the NEW user's
    // session cookie onto this response — logging the owner in as the staff
    // member they just created. Building the user + credential account by
    // hand creates no session at all.
    const ctx = await auth.$context
    const normalizedEmail = email.toLowerCase()
    if (await ctx.internalAdapter.findUserByEmail(normalizedEmail)) {
      throw new Error('EMAIL_TAKEN')
    }

    const hash = await ctx.password.hash(password)
    const created = await ctx.internalAdapter.createUser(
      { email: normalizedEmail, name, emailVerified: false },
      { method: 'email-password' },
    )
    await ctx.internalAdapter.linkAccount({
      userId: created.id,
      providerId: 'credential',
      issuer: createLocalAccountIssuer('credential'),
      accountId: created.id,
      password: hash,
    })

    await auth.api.addMember({
      body: {
        userId: created.id,
        organizationId,
        role: role as SalonRole,
        ...(branchId ? { teamId: branchId } : {}),
      },
    })

    return Response.json({ user: created }, { status: 201 })
  } catch (e) {
    if (e instanceof PlanError) {
      return Response.json({ error: e.code, ...e.meta }, { status: 402 })
    }
    const msg = e instanceof Error ? e.message : 'ERROR'
    return Response.json({ error: msg }, { status: STATUS[msg] ?? 400 })
  }
}
