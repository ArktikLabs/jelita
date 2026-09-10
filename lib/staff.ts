import { createLocalAccountIssuer } from 'better-auth'
import { sql } from 'drizzle-orm'
import { headers } from 'next/headers'
import { auth, MIN_PASSWORD_LENGTH } from './auth'
import { db } from './db'
import { ASSIGNABLE_ROLES, type SalonRole } from './permissions'
import { PlanError, requireQuota } from './plan/entitlements'
import { getBranchStatus } from './plan/branch'
import {
  clampPage, orderBy, paginate, toResult,
  type FilterRule, type ListQuery, type ListResult, type ListSpec,
} from './list-query'

export type StaffRow = {
  userId: string
  name: string
  email: string
  role: string
  teamId: string | null
  branchName: string | null
  active: boolean
}

const rowsToStaff = (rows: Record<string, unknown>[]): StaffRow[] =>
  rows.map((r) => ({
    userId: r.user_id as string,
    name: r.name as string,
    email: r.email as string,
    role: r.role as string,
    teamId: (r.team_id as string) ?? null,
    branchName: (r.branch_name as string) ?? null,
    active: (r.active as boolean) ?? true,
  }))

export async function provisionStaff(input: {
  organizationId: string
  name: string
  email: string
  password: string
  role: SalonRole
  teamId?: string | null
  actorUserId: string
}) {
  // The allow-list, not `role in roles`: `roles` contains 'owner', and
  // better-auth's addMember performs NO permission check on the role it writes
  // (node_modules/better-auth/dist/plugins/organization/routes/crud-members.mjs
  // -- it validates the caller's membership and the teamId, never the role), so
  // an admin holding staff:['create'] could mint an owner and inherit rights
  // they never held. Every creation path routes through this function (spec
  // §8), so the guard lives here once rather than once per caller -- the JSON
  // API route had none at all.
  if (!ASSIGNABLE_ROLES.includes(input.role)) throw new Error('UNKNOWN_ROLE')
  // Same reason: the actions checked this and the JSON route did not, so
  // "password":"a" minted a working login below the configured minimum.
  if (input.password.length < MIN_PASSWORD_LENGTH) throw new Error('PASSWORD_TOO_SHORT')
  // A branch the owner closed, or one the plan tier has outgrown, must not
  // silently acquire a new hire -- every creation path routes through this
  // function, so the guard lives here once rather than once per caller
  // (the Server Action and the JSON API both call provisionStaff directly).
  // Same pattern as lib/session.ts's requireBranch({ write: true }).
  if (input.teamId) {
    const status = await getBranchStatus(input.teamId, input.organizationId)
    if (status === 'over_cap') throw new PlanError('BRANCH_LOCKED', { branchId: input.teamId })
    if (status === 'closed') throw new Error('BRANCH_CLOSED')
  }
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

  // addMember is what validates teamId against the org, and it runs AFTER the
  // two writes above -- so anything it (or the assignment below) rejects used
  // to leave an orphaned users + accounts row with no members row: invisible in
  // /staff, still able to sign in, and that email EMAIL_TAKEN forever. Undo the
  // whole hire on any failure, the way the import loop already compensates
  // (app/dashboard/(shell)/staff/actions.ts). deleteUser removes the user row; accounts,
  // members and staff_profiles cascade off it.
  try {
    await auth.api.addMember({
      body: {
        userId: created.id,
        organizationId: input.organizationId,
        role: input.role,
        ...(input.teamId ? { teamId: input.teamId } : {}),
      },
    })

    // The members insert fired the trigger, so a profile exists with team_id
    // null and no actor at all -- the trigger runs inside Postgres with no
    // idea who called addMember. Stamp it here, the one place that knows.
    await db.execute(sql`
      update staff_profiles set created_by = ${input.actorUserId}
       where user_id = ${created.id} and organization_id = ${input.organizationId}`)
    // Assignment is this module's job -- see the pairing note below.
    if (input.teamId) {
      await assignBranch(created.id, input.organizationId, input.teamId, input.actorUserId)
    }
  } catch (e) {
    await ctx.internalAdapter.deleteUser(created.id)
    throw e
  }
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
 * Through provisionStaff, better-auth's addMember already validated teamId
 * against the org and wrote team_members itself, with rollback if that
 * failed -- so there this function's `exists()` guard is a safety net, not
 * something exercised. app/dashboard/(shell)/staff/actions.ts's transferStaffAction is
 * the first standalone caller: it moves an EXISTING member, so there is no
 * addMember to have already validated teamId, and it is authoritative --
 * the caller no longer pre-checks teamId ownership itself, it trusts the
 * `updated` return value here. scripts/staff-check.mjs section 8 exercises
 * this directly, including a teamId belonging to another salon.
 *
 * A branch-assigning call also clears any OTHER team_members row this person
 * holds in the same salon -- one branch each (spec §2.1), and a stale row is
 * where a fresh login lands (lib/auth.ts reads the oldest one).
 *
 * Returns whether a row was actually updated: false means either the
 * (userId, organizationId) pair doesn't exist, or teamId doesn't belong to
 * organizationId -- the caller can't tell which, and shouldn't need to (both
 * read as "not found" to the operator).
 */
export async function assignBranch(
  userId: string, organizationId: string, teamId: string | null, actorUserId: string,
): Promise<boolean> {
  const result = await db.execute(sql`
    update staff_profiles set team_id = ${teamId}, updated_by = ${actorUserId}
     where user_id = ${userId} and organization_id = ${organizationId}
       and (${teamId}::text is null or exists (
         select 1 from teams where id = ${teamId}
           and organization_id = ${organizationId}))`)
  const updated = (result.rowCount ?? 0) > 0
  // Only reachable once the update above actually matched a row -- otherwise
  // teamId may not belong to organizationId at all, and addTeamMember (which
  // org-scopes teamId itself) would throw rather than no-op.
  if (teamId && updated) {
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
    const h = await headers()
    await auth.api.addTeamMember({ body: { teamId, userId, organizationId }, headers: h })

    // ...and REMOVE the rows this move replaces. Assignment is one branch per
    // person (spec §2.1) and this module owns the pair (§3.3), but transfer
    // only ever added: both rows survived, and lib/auth.ts's session hook
    // resolves activeTeamId from the OLDEST team_members row for the org, so a
    // transferred front-desk user signed back in at their OLD branch -- and
    // frontdesk holds branch:['read'] with no switch, so they could not correct
    // it and every requireBranch()-scoped write landed in a branch they no
    // longer work at.
    //
    // Added first, removed second: if the add fails they keep a navigational
    // row rather than none. Signature confirmed against the installed source,
    // node_modules/better-auth/dist/plugins/organization/routes/crud-team.mjs
    // (removeTeamMember, body { teamId, userId, organizationId? },
    // `requireHeaders: true, use: [orgMiddleware, orgSessionMiddleware]`, and
    // it checks the CALLING session's member:['delete'] -- so it needs the
    // caller's own headers, exactly like addTeamMember above).
    const { rows: stale } = await db.execute(sql`
      select tm.team_id from team_members tm
        join teams t on t.id = tm.team_id
       where tm.user_id = ${userId} and t.organization_id = ${organizationId}
         and tm.team_id <> ${teamId}`)
    for (const row of stale as { team_id: string }[]) {
      await auth.api.removeTeamMember({
        body: { teamId: row.team_id, userId, organizationId },
        headers: h,
      })
    }
  }
  return updated
}

/**
 * Staff of one salon, unpaged. Pass userId to narrow to one; the org scoping
 * is in the query either way, so a bare id from the client cannot cross
 * tenants.
 *
 * The building block for everything that needs the WHOLE roster rather than
 * one page of it: the calendar's lane list and the POS performer picker both
 * iterate every staff member, not a page -- narrowing either to page 1 of the
 * staff list would silently hide anyone past it.
 *
 * Same GROUP BY dedup as `listStaff` below, and for the same reason: `members`
 * carries no unique on (user_id, organization_id) by design (migration
 * 0010_services.sql), so a person with two membership rows would otherwise
 * come back twice here too -- worse than a wrong count, because a picker
 * showing the same stylist twice gives whoever is choosing no way to tell the
 * two entries apart. See listStaff's docstring for why GROUP BY (not relying
 * on Postgres's PK-only functional-dependency inference) and why
 * string_agg(m.role, ',' order by m.role), not MIN(m.role).
 */
export async function staffOf(
  organizationId: string, userId?: string,
): Promise<StaffRow[]> {
  const { rows } = await db.execute(sql`
    select u.id as user_id, u.name, u.email,
           string_agg(m.role, ',' order by m.role) as role,
           s.team_id, t.name as branch_name, s.active
      from members m
      join users u on u.id = m.user_id
      left join staff_profiles s
        on s.user_id = m.user_id and s.organization_id = m.organization_id
      left join teams t on t.id = s.team_id
     where m.organization_id = ${organizationId}
       ${userId === undefined ? sql`` : sql`and u.id = ${userId}`}
     group by u.id, u.name, u.email, s.team_id, t.name, s.active
     order by u.name, u.id`)
  return rowsToStaff(rows as Record<string, unknown>[])
}

/**
 * Task 4's audit trail (spec §5), added to `getStaff` alone -- `staffOf`
 * itself stays untouched so the roster list (and every other caller that
 * iterates the whole staff table) does not pay for three extra joins it
 * never reads.
 *
 * No fallback for a null created_by: every write path into `staff_profiles`
 * (provisionStaff, called by the dashboard form, the JSON API and the CSV
 * import loop alike) requires a signed-in actor, so a null one only ever
 * comes from the seed script's direct `members` insert -- no nameable
 * context, hence omitted rather than guessed.
 *
 * `updatedByName` is suppressed when it is the SAME actor who created the
 * row within a few seconds -- provisionStaff inserts the row and then
 * assignBranch updates it immediately after (same function, same actor), so
 * a naive "updated_at moved" check would print a "diubah" line for every
 * single hire.
 */
export async function getStaff(userId: string, organizationId: string) {
  const [row] = await staffOf(organizationId, userId)
  if (!row) return null

  const { rows: auditRows } = await db.execute(sql`
    select cb.name as created_by_name, to_char(s.created_at, 'DD-MM-YYYY') as created_display,
           ub.name as updated_by_name, to_char(s.updated_at, 'DD-MM-YYYY') as updated_display,
           (s.updated_by is not null and (
             s.updated_by is distinct from s.created_by
             or extract(epoch from s.updated_at - s.created_at) > 10
           )) as show_updated,
           delb.name as deleted_by_name, to_char(s.deleted_at, 'DD-MM-YYYY') as deleted_display
      from staff_profiles s
      left join users cb on cb.id = s.created_by
      left join users ub on ub.id = s.updated_by
      left join users delb on delb.id = s.deleted_by
     where s.user_id = ${userId} and s.organization_id = ${organizationId}`)
  const a = auditRows[0] as Record<string, unknown> | undefined
  const audit = {
    createdByName: (a?.created_by_name as string) ?? null,
    createdAt: (a?.created_display as string) ?? '',
    updatedByName: a?.show_updated ? (a.updated_by_name as string) : null,
    updatedAt: (a?.updated_display as string) ?? '',
    deletedByName: (a?.deleted_by_name as string) ?? null,
    deletedAt: (a?.deleted_display as string) ?? null,
  }

  return { ...row, audit }
}

/**
 * What a URL may ask of the staff list.
 *
 * `name` is the only sortable column, and even it is an exception to §3.2's
 * "only if an index supports it" rule: it orders by `users.name`, and `users`
 * is not tenant-partitioned (better-auth's own table, shared across every
 * salon), so there is no `(organization_id, name)` index to build for it and
 * never will be -- every staff list is a join-then-sort by construction, not
 * an index range scan. No other column here has index support either
 * (`members` is indexed only on organization_id and user_id, `staff_profiles`
 * carries no index beyond its unique constraint), so nothing else is
 * declared sortable. §3.2's table needs a correction for this; Task 6 makes
 * it.
 */

/**
 * `?branch=<team id>`. Legal by SHAPE, not by membership: the legal set is
 * this salon's own team ids, which are DB data the spec cannot see (unlike
 * `active`'s fixed true/false). Any non-empty string is accepted -- the WHERE
 * clause below binds it as a PARAMETER, never `sql.raw`, so an id belonging
 * to no branch (or to another salon's) simply matches zero rows, exactly the
 * behaviour the page's old unchecked `?branch=` param already had. Folding
 * it in here (Task 5) is what lets it be declared instead of read off
 * searchParams behind the contract's back.
 */
const branchFilter: FilterRule = (raw) => (raw === '' ? null : raw)

export const STAFF_LIST: ListSpec<'name'> = {
  sortable: { name: 'u.name' },
  defaultSort: 'name',
  tiebreak: 'u.id',
  // `active` matches the other four resources that carry the column
  // (products, services, branches) -- staff was one of the two gaps found
  // while building the FilterBar (Task 5).
  filters: { branch: branchFilter, active: ['true', 'false'] },
}

/**
 * One page of a salon's staff.
 *
 * `count(DISTINCT m.user_id)`, not `count(*)`: staff is the one list of the
 * six where the join can return more than one row per person -- `members`
 * carries no unique on (user_id, organization_id) by design (see staffOf
 * above), so a plain `count(*)` here would report one person twice. Every
 * other list in this codebase joins 1:1 and uses `count(*)`; this is the
 * exception, and `tests/staff.db.test.ts`'s two-membership-row test is what
 * keeps it from silently regressing back to `count(*)`.
 *
 * The page query needs the same de-duplication: GROUP BY m.user_id (plus the
 * other selected columns, since only `staff_profiles` -- not `members` --
 * carries a uniqueness guarantee per person, and Postgres only infers
 * functional dependence from a table's PRIMARY KEY, not from an arbitrary
 * unique constraint). Where two membership rows disagree, `role` is every
 * role joined with `,` (string_agg ... order by m.role) -- not a pick of one.
 * `members.role` is itself comma-separated, so every consumer already
 * `.split(',')`s this column; collapsing to one role (MIN or otherwise) would
 * silently drop membership a person actually holds -- MIN specifically once
 * made a second, weaker membership row (e.g. 'admin') hide an 'owner' row
 * behind it, since MIN is alphabetical and 'admin' < 'owner'. See
 * `app/dashboard/(shell)/staff/actions.ts`'s owner guards, which depend on
 * `role.split(',').includes('owner')` being true whenever ANY of a person's
 * rows says owner.
 *
 * `query.filters.branch` narrows to one branch, same as the page's old
 * client-side `?branch=` filter -- now applied in SQL instead of after
 * fetching the whole roster, since fetching is now paged, and now DECLARED
 * on STAFF_LIST rather than a third parameter this function trusted the
 * caller to have validated itself.
 */
export async function listStaff(
  organizationId: string, query: ListQuery,
): Promise<ListResult<StaffRow>> {
  const where = sql`
    where m.organization_id = ${organizationId}
      ${query.filters.branch === undefined ? sql`` : sql`and s.team_id = ${query.filters.branch}`}
      ${query.filters.active === undefined
        ? sql``
        : sql`and s.active = ${query.filters.active === 'true'}`}`

  const fetch = async (q: ListQuery) => {
    const { rows } = await db.execute(sql`
      select u.id as user_id, u.name, u.email,
             string_agg(m.role, ',' order by m.role) as role,
             s.team_id, t.name as branch_name, s.active
        from members m
        join users u on u.id = m.user_id
        left join staff_profiles s
          on s.user_id = m.user_id and s.organization_id = m.organization_id
        left join teams t on t.id = s.team_id
        ${where}
       group by u.id, u.name, u.email, s.team_id, t.name, s.active
       ${orderBy(STAFF_LIST, q)} ${paginate(q)}`)
    return rowsToStaff(rows as Record<string, unknown>[])
  }

  const [rows, countRows] = await Promise.all([
    fetch(query),
    db.execute(sql`
      select count(distinct m.user_id)::int as n
        from members m
        left join staff_profiles s
          on s.user_id = m.user_id and s.organization_id = m.organization_id
        ${where}`),
  ])
  const total = (countRows.rows[0] as { n: number }).n

  const clamped = clampPage(query, total)
  return toResult(
    clamped.page === query.page ? rows : await fetch(clamped),
    total,
    clamped,
  )
}

/**
 * The deactivation write. "The last active owner cannot be deactivated" is
 * PREVENTED, not handled (spec §6.3), so the count and the write are ONE
 * statement -- see deactivateStaffAction, which carries the full race
 * reasoning (two owners deactivating two different peers under READ
 * COMMITTED). Returns whether a row actually closed: false means either
 * already inactive (a double submit) or the last-owner refusal, and the
 * caller re-reads to tell those apart, the same way it always has.
 */
export async function deactivateStaff(
  userId: string, organizationId: string, actorUserId: string,
): Promise<boolean> {
  const { rows: closed } = await db.execute(sql`
    with owners as materialized (
      select s.user_id from staff_profiles s
        join members m on m.user_id = s.user_id
                      and m.organization_id = s.organization_id
       where s.organization_id = ${organizationId} and s.active
         and (string_to_array(m.role, ',') && array['owner'])
       order by s.user_id
         -- of s, m: see deactivateStaffAction for why members must be locked
         -- too, not just staff_profiles.
         for update of s, m
    )
    update staff_profiles
       set active = false, deleted_at = now(), deleted_by = ${actorUserId}
     where user_id = ${userId} and organization_id = ${organizationId}
       and active
       and (user_id not in (select user_id from owners)
            or (select count(*) from owners) > 1)
    returning user_id`)
  return closed.length > 0
}

/** Rehiring clears the deactivation stamp -- a live row must not still claim
 *  a deletion date. `updated_by` moves too: reactivating is itself a change,
 *  even with no "reactivated_by" column of its own. */
export async function reactivateStaff(
  userId: string, organizationId: string, actorUserId: string,
): Promise<void> {
  await db.execute(sql`
    update staff_profiles
       set active = true, deleted_at = null, deleted_by = null, updated_by = ${actorUserId}
     where user_id = ${userId} and organization_id = ${organizationId}`)
}
