import { createLocalAccountIssuer } from 'better-auth'
import { sql } from 'drizzle-orm'
import { headers } from 'next/headers'
import { auth } from './auth'
import { db } from './db'
import { roles, type SalonRole } from './permissions'
import { requireQuota } from './plan/entitlements'

export type StaffRow = {
  userId: string
  name: string
  email: string
  role: string
  teamId: string | null
  branchName: string | null
  active: boolean
}

export async function provisionStaff(input: {
  organizationId: string
  name: string
  email: string
  password: string
  role: SalonRole
  teamId?: string | null
}) {
  if (!(input.role in roles)) throw new Error('UNKNOWN_ROLE')
  await requireQuota('staff')

  // Create the login directly instead of via signUpEmail: that endpoint mints
  // a session, and nextCookies() would then write the NEW user's session
  // cookie onto this response -- logging the owner in as the staff member they
  // just created. Building the user + credential account by hand creates no
  // session at all.
  const ctx = await auth.$context
  const email = input.email.toLowerCase()
  if (await ctx.internalAdapter.findUserByEmail(email)) throw new Error('EMAIL_TAKEN')

  const hash = await ctx.password.hash(input.password)
  // Verified true, not false: this account never goes through
  // sendVerificationEmail at all, so requireEmailVerification would lock the
  // new hire out of sign-in forever. The owner creating the login IS the
  // verification -- the same trust that lets this route skip signUpEmail.
  const created = await ctx.internalAdapter.createUser(
    { email, name: input.name, emailVerified: true },
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
      organizationId: input.organizationId,
      role: input.role,
      ...(input.teamId ? { teamId: input.teamId } : {}),
    },
  })

  // The members insert fired the trigger, so a profile exists with team_id
  // null. Assignment is this module's job -- see the pairing note below.
  if (input.teamId) await assignBranch(created.id, input.organizationId, input.teamId)
  return { user: created }
}

/**
 * Assignment is TWO rows:
 *
 *   staff_profiles.team_id  -- who works here (this app's authority)
 *   team_members            -- navigational; the session hook reads it to
 *                              resolve activeTeamId on login (lib/auth.ts),
 *                              and setActiveTeam refuses a user without it
 *
 * Through the only path that exists today (provisionStaff), better-auth's
 * addMember already validated teamId against the org and wrote team_members
 * itself, with rollback if that failed -- so this function's `exists()`
 * guard and its own addTeamMember call are a safety net for a future
 * standalone caller (e.g. a branch-transfer action), not something exercised
 * yet. scripts/staff-check.mjs asserts the pair agrees on the provisioning
 * path; a standalone assignBranch call has no coverage until that caller
 * exists.
 */
export async function assignBranch(
  userId: string, organizationId: string, teamId: string | null,
) {
  await db.execute(sql`
    update staff_profiles set team_id = ${teamId}, updated_at = now()
     where user_id = ${userId} and organization_id = ${organizationId}
       and (${teamId}::text is null or exists (
         select 1 from teams where id = ${teamId}
           and organization_id = ${organizationId}))`)
  if (teamId) {
    // addTeamMember requires a real session (orgSessionMiddleware): unlike
    // addMember above, it checks the CALLING session's own member:update
    // permission via better-auth's `hasPermission`, so it needs the actual
    // caller's headers, not an empty Headers() -- confirmed by reading
    // node_modules/better-auth/dist/plugins/organization/routes/crud-team.mjs,
    // where addTeamMember is built with `requireHeaders: true, use:
    // [orgMiddleware, orgSessionMiddleware]`. Every caller of this module
    // (the API route today, Server Actions next) runs inside a request
    // scope, so next/headers resolves to the same cookies the caller's own
    // permission check already used.
    await auth.api.addTeamMember({
      body: { teamId, userId, organizationId },
      headers: await headers(),
    })
  }
}

/** Staff of one salon. Pass userId to narrow to one; the org scoping is in
 *  the query either way, so a bare id from the client cannot cross tenants. */
export async function listStaff(
  organizationId: string, userId?: string,
): Promise<StaffRow[]> {
  const { rows } = await db.execute(sql`
    select u.id as user_id, u.name, u.email, m.role,
           s.team_id, t.name as branch_name, s.active
      from members m
      join users u on u.id = m.user_id
      left join staff_profiles s
        on s.user_id = m.user_id and s.organization_id = m.organization_id
      left join teams t on t.id = s.team_id
     where m.organization_id = ${organizationId}
       ${userId === undefined ? sql`` : sql`and u.id = ${userId}`}
     order by u.name, u.id`)
  return (rows as Record<string, unknown>[]).map((r) => ({
    userId: r.user_id as string,
    name: r.name as string,
    email: r.email as string,
    role: r.role as string,
    teamId: (r.team_id as string) ?? null,
    branchName: (r.branch_name as string) ?? null,
    active: (r.active as boolean) ?? true,
  }))
}

export async function getStaff(userId: string, organizationId: string) {
  const [row] = await listStaff(organizationId, userId)
  return row ?? null
}
