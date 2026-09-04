import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { organization } from 'better-auth/plugins'
import { nextCookies } from 'better-auth/next-js'
import { APIError } from 'better-auth/api'
import { and, asc, eq } from 'drizzle-orm'
import { db } from './db'
import { branchProfiles, members, teamMembers, teams } from './schema'
import { organizationOf, sendNow } from './notify'
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

/**
 * better-auth enforces this on its own sign-up/reset endpoints. provisionStaff
 * and the staff Server Actions never touch those endpoints (see lib/staff.ts),
 * so they check it themselves -- against this constant, not a second literal
 * that could drift from the config below.
 */
export const MIN_PASSWORD_LENGTH = 8

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg', usePlural: true }),

  emailAndPassword: {
    enabled: true,
    minPasswordLength: MIN_PASSWORD_LENGTH,
    // Salon staff are created by the owner, not self-service; no inbox round
    // trip before they can work.
    //
    // ON by default, and turned off only by an EXPLICIT opt-out: an
    // unrecognised value keeps verification required, so a typo weakens
    // nothing. Anything else would make the safe state the one you have to
    // remember.
    //
    // The demo deployment sets REQUIRE_EMAIL_VERIFICATION=false, because with
    // no mail transport the verification link reaches only the server log --
    // .mail.log cannot be written on a read-only serverless filesystem -- and
    // requiring it makes self-registration a dead end with no way out.
    //
    // What that costs, said plainly: anyone can then register under an address
    // they do not own. Acceptable for a demo whose data is seeded and
    // disposable; NOT acceptable once a real salon's money is in here, so set
    // RESEND_API_KEY and drop the flag before that happens.
    //
    // Staff accounts are unaffected either way -- lib/staff.ts creates them
    // already verified, because an owner adding a stylist IS the proof.
    requireEmailVerification: process.env.REQUIRE_EMAIL_VERIFICATION !== 'false',
    sendResetPassword: async ({ user, url, token }) => {
      // The URL goes in `secret`, so the copy stored for the Notification
      // Center keeps `{{link}}` written out rather than a live reset link that
      // front desk could read. See lib/notify.ts sendNow.
      await sendNow({
        organizationId: await organizationOf(user.id),
        kind: 'password_reset',
        to: user.email,
        subject: 'Reset kata sandi — Jelita Salon',
        vars: { name: user.name, salon: 'Jelita' },
        secret: { link: `${url}\n\ntoken=${token}` },
      })
    },
  },

  emailVerification: {
    sendOnSignUp: true,
    // Without this an unverified sign-in is a permanent dead end: FORBIDDEN,
    // no fresh link, no resend screen anywhere, and password reset does not
    // set emailVerified. One lost mail would kill the account.
    sendOnSignIn: true,
    // Clicking a link in your own inbox is proof of possession; charging a
    // second login for it is friction that buys nothing.
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url, token }) => {
      // Usually NO organization: this fires at signup, when the account exists
      // and the salon does not. The row is written scoped to no salon and is
      // therefore invisible in every Center -- see the spec, §4.
      await sendNow({
        organizationId: await organizationOf(user.id),
        kind: 'email_verification',
        to: user.email,
        subject: 'Verifikasi email — Jelita Salon',
        vars: { name: user.name },
        secret: { link: `${url}\n\ntoken=${token}` },
      })
    },
  },

  rateLimit: {
    // No `enabled` key on purpose. better-auth's default is production-only,
    // which is what we want; setting enabled:true forces limiting on in dev
    // and trips the test suites. Verified: 30 rapid failed sign-ins in dev
    // returned 401 and never 429.
    customRules: {
      '/sign-up/email': { window: 3600, max: 5 },
      '/sign-in/email': { window: 60, max: 10 },
      '/request-password-reset': { window: 3600, max: 5 },
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
         * Multi-salon membership is reachable via /organization/accept-invitation,
         * so a user can belong to more than one salon. The oldest membership
         * wins (deterministic tiebreak on id), and the branch lookup is
         * constrained to that same organization so activeTeamId can never
         * resolve to a branch belonging to a different salon, and to active
         * branches so a fresh login never lands in one the owner closed.
         */
        before: async (session) => {
          const [m] = await db
            .select({ organizationId: members.organizationId })
            .from(members)
            .where(eq(members.userId, session.userId))
            .orderBy(asc(members.createdAt), asc(members.id))
            .limit(1)
          if (!m) return
          const [t] = await db
            .select({ teamId: teamMembers.teamId })
            .from(teamMembers)
            .innerJoin(teams, eq(teamMembers.teamId, teams.id))
            .innerJoin(branchProfiles, eq(teams.id, branchProfiles.teamId))
            .where(
              and(
                eq(teamMembers.userId, session.userId),
                eq(teams.organizationId, m.organizationId),
                eq(branchProfiles.active, true),
              ),
            )
            .orderBy(asc(teamMembers.createdAt), asc(teamMembers.id))
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
        await sendNow({
          organizationId: organization.id,
          kind: 'invitation',
          to: email,
          subject: `Undangan bergabung — ${organization.name}`,
          vars: { inviter: inviter.user.name, salon: organization.name },
          secret: {
            link: `${process.env.BETTER_AUTH_URL}/accept-invitation/${id}`
              + `\n\ninvitationId=${id}`,
          },
        })
      },
      teams: { enabled: true, maximumTeams: 20 },
      // Seats are counted from `members`, so a pending invitation holds
      // none — acceptance is the authoritative gate, invitation only a
      // courtesy early warning.
      organizationHooks: {
        // NOTE: better-auth also fires beforeCreateTeam for the default team it
        // auto-creates during organization creation, so signup is branch-quota
        // checked too. Safe because a `branches` cap below 1 is unrepresentable
        // — see the plan_limits_branches_min constraint in migration 0006, which
        // exists precisely so this hook cannot fail mid-signup.
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
