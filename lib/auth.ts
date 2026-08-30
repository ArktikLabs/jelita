import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { organization } from 'better-auth/plugins'
import { nextCookies } from 'better-auth/next-js'
import { APIError } from 'better-auth/api'
import { eq } from 'drizzle-orm'
import { db } from './db'
import { members, teamMembers } from './schema'
import { sendMail } from './mailer'
import { ac, roles } from './permissions'
import { PlanError, requireQuota } from './plan/entitlements'
import type { CappedResource } from './plan/catalog'

/**
 * Quota guard for better-auth's own resource-creating endpoints — a route
 * handler of ours would never see them.
 *
 * Wired as organizationHooks (not a global `before` hook) so it runs AFTER
 * better-auth has authenticated the caller, checked their permission and
 * RESOLVED the target organization: `ctx.body.organizationId` wins over the
 * session's active org, so the caller's active salon is the wrong tenant to
 * bill. That ordering also keeps 401/403 ahead of 402, so a plan's name, cap
 * and seat usage never leak to someone who wasn't allowed in.
 */
async function assertQuota(resource: CappedResource, organizationId: string) {
  try {
    await requireQuota(resource, organizationId)
  } catch (e) {
    if (e instanceof PlanError) {
      throw new APIError('PAYMENT_REQUIRED', { error: e.code, ...e.meta })
    }
    throw e
  }
}

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg', usePlural: true }),

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    // Salon staff are created by the owner, not self-service; no inbox round
    // trip before they can work.
    requireEmailVerification: false,
    sendResetPassword: async ({ user, url, token }) => {
      await sendMail(
        user.email,
        'Reset kata sandi — Jelita Salon',
        `Klik untuk mengatur ulang kata sandi Anda:\n${url}\n\ntoken=${token}`,
      )
    },
  },

  databaseHooks: {
    session: {
      create: {
        /**
         * activeOrganizationId/activeTeamId live on the session row, so a new
         * session starts with both null — after every login or password
         * change the user would have no salon and no branch, and every
         * §5.8-scoped query would fail until something called set-active.
         *
         * Salon staff belong to exactly one salon (and non-admins to one
         * branch), so resolve both at session creation instead.
         */
        before: async (session) => {
          const [m] = await db
            .select({ organizationId: members.organizationId })
            .from(members)
            .where(eq(members.userId, session.userId))
            .limit(1)
          if (!m) return
          const [t] = await db
            .select({ teamId: teamMembers.teamId })
            .from(teamMembers)
            .where(eq(teamMembers.userId, session.userId))
            .limit(1)
          return {
            data: {
              ...session,
              activeOrganizationId: m.organizationId,
              activeTeamId: t?.teamId ?? null,
            },
          }
        },
      },
    },
  },

  plugins: [
    // Tenancy (PRD §5.8): organization = salon, team = branch.
    // session.activeOrganizationId scopes the tenant; activeTeamId is the
    // branch selector. Front desk gets one teamMember row and cannot address
    // another branch; admin switches teams.
    organization({
      ac,
      roles,
      creatorRole: 'owner',
      sendInvitationEmail: async ({ email, inviter, organization, id }) => {
        await sendMail(
          email,
          `Undangan bergabung — ${organization.name}`,
          `${inviter.user.name} mengundang Anda bergabung di ${organization.name}.\n`
            + `${process.env.BETTER_AUTH_URL}/accept-invitation/${id}\n\ninvitationId=${id}`,
        )
      },
      teams: { enabled: true, maximumTeams: 20 },
      // Seats are counted from `members`, so a pending invitation holds
      // none — acceptance is the authoritative gate, invitation only a
      // courtesy early warning.
      organizationHooks: {
        beforeCreateTeam: ({ organization }) => assertQuota('branches', organization.id),
        beforeAcceptInvitation: ({ organization }) => assertQuota('staff', organization.id),
        beforeCreateInvitation: ({ organization }) => assertQuota('staff', organization.id),
      },
      // Lets an owner define salon-specific roles at runtime (e.g. "senior
      // stylist who may also void") without a redeploy — the multi-tenant
      // case in PRD §2, where each client wants slightly different rules.
      dynamicAccessControl: { enabled: true },
    }),
    nextCookies(), // must stay last
  ],
})
