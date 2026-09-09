import { sql } from 'drizzle-orm'
import { db } from './db'
import {
  clampPage, orderBy, paginate, toResult,
  type ListQuery, type ListResult, type ListSpec,
} from './list-query'

export type BranchRow = {
  teamId: string
  name: string
  address: string | null
  phone: string | null
  active: boolean
  withinCap: boolean
  staffCount: number
}

export type HourRow = {
  weekday: number
  closed: boolean
  opensAt: string
  closesAt: string
}

const rowsToBranches = (rows: Record<string, unknown>[]): BranchRow[] =>
  rows.map((r) => ({
    teamId: r.team_id as string,
    name: r.name as string,
    address: (r.address as string) ?? null,
    phone: (r.phone as string) ?? null,
    active: r.active as boolean,
    withinCap: r.within_cap as boolean,
    staffCount: Number(r.staff_count),
  }))

/**
 * Branches of one salon, oldest first -- unpaged. Pass `teamId` to narrow to
 * one branch -- the organizationId scoping is in the query either way, so a
 * bare id from the client can never reach another tenant's branch.
 *
 * The building block for everything that needs EVERY branch rather than one
 * page of them: the branch switcher, the staff forms' branch dropdown, the
 * per-branch override loop and the branch-cap check all iterate the whole
 * set, not a page of it.
 */
export async function branchesOf(
  organizationId: string, teamId?: string,
): Promise<BranchRow[]> {
  const { rows } = await db.execute(sql`
    select t.id as team_id, t.name, p.address, p.phone, p.active,
           coalesce(e.within_cap, false) as within_cap,
           -- Stationed staff, matching assignedStaff below: this number is
           -- what the deactivation block is about, so a working owner must
           -- not inflate it into a block that never lifts.
           (select count(*) from staff_profiles s
              join members m on m.user_id = s.user_id
                            and m.organization_id = s.organization_id
             where s.team_id = t.id
               and s.organization_id = t.organization_id
               and s.active and is_stationed(m.role))::int as staff_count
      from teams t
      join branch_profiles p on p.team_id = t.id
      left join branch_entitlement e on e.team_id = t.id
     where t.organization_id = ${organizationId}
       ${teamId === undefined ? sql`` : sql`and t.id = ${teamId}`}
     order by t.created_at, t.id`)
  return rowsToBranches(rows as Record<string, unknown>[])
}

/** What a URL may ask of the branches list. */
export const BRANCH_LIST: ListSpec<'name'> = {
  sortable: { name: 't.name' },
  defaultSort: 'name',
  tiebreak: 't.id',
  searchable: true,
  // `active` lives on branch_profiles, not on `teams` itself -- see the
  // `where` fragment and the count query's join below. Same column customers,
  // products, services and staff carry; branches was one of the two gaps
  // found while building the FilterBar (Task 5).
  filters: { active: ['true', 'false'] },
}

/**
 * One page of a salon's branches.
 *
 * The count query now joins `branch_profiles`: `where` reaches `p.active`
 * once the filter above is set, and teams<->branch_profiles is 1:1 (every
 * team is seeded exactly one profile row) so the join changes no count, only
 * what columns are in scope for it.
 */
export async function listBranches(
  organizationId: string, query: ListQuery,
): Promise<ListResult<BranchRow>> {
  const term = (query.q ?? '').trim()
  const like = `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`

  const where = sql`
    where t.organization_id = ${organizationId}
      ${term === '' ? sql`` : sql`and t.name ilike ${like}`}
      ${query.filters.active === undefined
        ? sql``
        : sql`and p.active = ${query.filters.active === 'true'}`}`

  const fetch = async (q: ListQuery) => {
    const { rows } = await db.execute(sql`
      select t.id as team_id, t.name, p.address, p.phone, p.active,
             coalesce(e.within_cap, false) as within_cap,
             (select count(*) from staff_profiles s
                join members m on m.user_id = s.user_id
                              and m.organization_id = s.organization_id
               where s.team_id = t.id
                 and s.organization_id = t.organization_id
                 and s.active and is_stationed(m.role))::int as staff_count
        from teams t
        join branch_profiles p on p.team_id = t.id
        left join branch_entitlement e on e.team_id = t.id
        ${where} ${orderBy(BRANCH_LIST, q)} ${paginate(q)}`)
    return rowsToBranches(rows as Record<string, unknown>[])
  }

  const [rows, countRows] = await Promise.all([
    fetch(query),
    db.execute(sql`
      select count(*)::int as n
        from teams t
        join branch_profiles p on p.team_id = t.id
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
 * Scoped by organizationId in the query itself, not just by the caller — a
 * bare `getBranch(teamId)` must be impossible to use across tenants.
 */
export async function getBranch(teamId: string, organizationId: string) {
  const [profile] = await branchesOf(organizationId, teamId)
  if (!profile) return null
  const { rows } = await db.execute(sql`
    select weekday, closed, opens_at, closes_at from branch_hours
     where team_id = ${teamId} order by weekday`)
  const hours = (rows as Record<string, unknown>[]).map((r) => ({
    weekday: Number(r.weekday),
    closed: r.closed as boolean,
    opensAt: String(r.opens_at).slice(0, 5),
    closesAt: String(r.closes_at).slice(0, 5),
  }))

  // Task 4's audit trail (spec §5). No fallback for a null created_by: every
  // branch is either seeded by the `teams` trigger with no actor of its own
  // (completeBranchCreation stamps one right after, but the default team a
  // fresh salon starts with never goes through that call) or created by a
  // signed-in owner/admin -- there is no third, nameable context to guess at.
  const { rows: auditRows } = await db.execute(sql`
    select cb.name as created_by_name, to_char(p.created_at, 'DD-MM-YYYY') as created_display,
           ub.name as updated_by_name, to_char(p.updated_at, 'DD-MM-YYYY') as updated_display,
           (p.updated_by is not null and (
             p.updated_by is distinct from p.created_by
             or extract(epoch from p.updated_at - p.created_at) > 10
           )) as show_updated,
           delb.name as deleted_by_name, to_char(p.deleted_at, 'DD-MM-YYYY') as deleted_display
      from branch_profiles p
      join teams t on t.id = p.team_id
      left join users cb on cb.id = p.created_by
      left join users ub on ub.id = p.updated_by
      left join users delb on delb.id = p.deleted_by
     where p.team_id = ${teamId} and t.organization_id = ${organizationId}`)
  const a = auditRows[0] as Record<string, unknown>
  const audit = {
    createdByName: (a.created_by_name as string) ?? null,
    createdAt: a.created_display as string,
    updatedByName: a.show_updated ? (a.updated_by_name as string) : null,
    updatedAt: a.updated_display as string,
    deletedByName: (a.deleted_by_name as string) ?? null,
    deletedAt: (a.deleted_display as string) ?? null,
  }

  return { profile, hours, audit }
}

/**
 * Fills in what createTeam and the trigger left blank: the profile's address,
 * phone, and who created it. Runs unconditionally -- even with neither field
 * filled in -- because created_by must be stamped either way, and
 * branch_profiles is seeded by a trigger on `teams` (db/migrations/0008) with
 * no actor of its own to record.
 *
 * Org-scoped like updateBranchDetails/deactivateBranch/reactivateBranch --
 * not reachable cross-tenant today (the only caller passes the id createTeam
 * just returned), but this was the one write on the branch with no org
 * predicate at all, defense in depth for the day another caller exists.
 */
export async function completeBranchCreation(
  teamId: string, organizationId: string,
  address: string | null, phone: string | null, actorUserId: string,
): Promise<void> {
  await db.execute(sql`
    update branch_profiles set address = ${address}, phone = ${phone}, created_by = ${actorUserId}
     where team_id = ${teamId}
       and exists (select 1 from teams
                    where id = ${teamId} and organization_id = ${organizationId})`)
}

/** The details form -- name goes through auth.api.updateTeam (the caller's
 *  job, since it needs the session's own headers); address/phone live here. */
export async function updateBranchDetails(
  teamId: string, organizationId: string,
  details: { address: string | null; phone: string | null },
  actorUserId: string,
): Promise<void> {
  await db.execute(sql`
    update branch_profiles
       set address = ${details.address}, phone = ${details.phone}, updated_by = ${actorUserId}
     where team_id = ${teamId}
       and exists (select 1 from teams
                    where id = ${teamId} and organization_id = ${organizationId})`)
}

/**
 * "The last active branch cannot be deactivated" is PREVENTED, not handled
 * (spec §7), so the count and the write are ONE statement -- see
 * deactivateBranchAction for the full race reasoning. Returns whether a row
 * actually closed: false means either already closed (a double submit) or a
 * foreign id, and the caller re-reads to tell those apart.
 */
export async function deactivateBranch(
  teamId: string, organizationId: string, actorUserId: string,
): Promise<boolean> {
  const { rows: closed } = await db.execute(sql`
    with live as materialized (
      select p.team_id from branch_profiles p
        join teams t on t.id = p.team_id
       where t.organization_id = ${organizationId} and p.active
       order by p.team_id
         for update of p
    )
    update branch_profiles set active = false, deleted_at = now(), deleted_by = ${actorUserId}
     where team_id = ${teamId}
       and team_id in (select team_id from live)
       and (select count(*) from live) > 1
    returning team_id`)
  return closed.length > 0
}

/** Reactivation clears the deletion stamp -- a live row must not still claim
 *  a deletion date; `updated_by` moves too, the same as every other
 *  reactivate in this phase. */
export async function reactivateBranch(
  teamId: string, organizationId: string, actorUserId: string,
): Promise<void> {
  await db.execute(sql`
    update branch_profiles
       set active = true, deleted_at = null, deleted_by = null, updated_by = ${actorUserId}
     where team_id = ${teamId}
       and exists (select 1 from teams
                    where id = ${teamId} and organization_id = ${organizationId})`)
}

/**
 * Names of the STAFF STATIONED at a branch, for the deactivation block.
 *
 * Reads staff_profiles, not team_members: the latter also holds navigational
 * rows for owners and admins, and counting those made every branch
 * undeactivatable. Inactive profiles are excluded -- someone who left must not
 * block closing the branch they used to work at.
 *
 * Owners and admins with a branch are excluded too, and for a different
 * reason. Since the working owner became bookable, team_id answers "works
 * here", and for a stylist that is also "is stationed here" -- their whole
 * position is that branch, so closing it strands them. An owner is not
 * stranded by closing a branch they own; counting them would make a salon
 * whose owner cuts hair unable to close that branch at all, which is the
 * every-branch-undeactivatable bug in a smaller costume.
 */
export async function assignedStaff(
  teamId: string, organizationId: string,
): Promise<string[]> {
  const { rows } = await db.execute(sql`
    select u.name from staff_profiles s
      join users u on u.id = s.user_id
      join members m on m.user_id = s.user_id and m.organization_id = s.organization_id
     where s.team_id = ${teamId} and s.organization_id = ${organizationId}
       and s.active and is_stationed(m.role)
     order by u.name`)
  return (rows as { name: string }[]).map((r) => r.name)
}
