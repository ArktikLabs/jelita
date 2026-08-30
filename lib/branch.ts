import { sql } from 'drizzle-orm'
import { db } from './db'

export type BranchRow = {
  teamId: string
  name: string
  address: string | null
  phone: string | null
  active: boolean
  withinCap: boolean
  memberCount: number
}

export type HourRow = {
  weekday: number
  closed: boolean
  opensAt: string
  closesAt: string
}

/**
 * Branches of one salon, oldest first. Pass `teamId` to narrow to one branch —
 * the organizationId scoping is in the query either way, so a bare id from the
 * client can never reach another tenant's branch.
 */
export async function listBranches(
  organizationId: string, teamId?: string,
): Promise<BranchRow[]> {
  const { rows } = await db.execute(sql`
    select t.id as team_id, t.name, p.address, p.phone, p.active,
           coalesce(e.within_cap, false) as within_cap, t.member_count
      from teams t
      join branch_profiles p on p.team_id = t.id
      left join branch_entitlement e on e.team_id = t.id
     where t.organization_id = ${organizationId}
       ${teamId === undefined ? sql`` : sql`and t.id = ${teamId}`}
     order by t.created_at, t.id`)
  return (rows as Record<string, unknown>[]).map((r) => ({
    teamId: r.team_id as string,
    name: r.name as string,
    address: (r.address as string) ?? null,
    phone: (r.phone as string) ?? null,
    active: r.active as boolean,
    withinCap: r.within_cap as boolean,
    memberCount: Number(r.member_count),
  }))
}

/**
 * Scoped by organizationId in the query itself, not just by the caller — a
 * bare `getBranch(teamId)` must be impossible to use across tenants.
 */
export async function getBranch(teamId: string, organizationId: string) {
  const [profile] = await listBranches(organizationId, teamId)
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
  return { profile, hours }
}

/**
 * Names of the STAFF assigned to a branch, for the deactivation block.
 *
 * `team_members` carries two different relations and only one of them is an
 * assignment:
 *
 *   Management membership is navigational; staff membership is assignment.
 *
 * better-auth requires a `team_members` row before `setActiveTeam` will let a
 * user into a branch, so an owner or admin gets one purely to be able to stand
 * there — and better-auth enrols the org creator into the default team by
 * itself. Counting those rows as "staff works here" made every branch
 * permanently undeactivatable, the owner blocking themselves by their own
 * navigation row. Org role decides: owner/admin never count, everyone else
 * does. (`members.role` is a comma-separated list — better-auth splits it on
 * `,` in hasPermissionFn — so the test is array overlap, not equality.)
 */
export async function assignedStaff(
  teamId: string, organizationId: string,
): Promise<string[]> {
  const { rows } = await db.execute(sql`
    select u.name from team_members tm
      join teams t on t.id = tm.team_id
      join users u on u.id = tm.user_id
      join members m on m.user_id = tm.user_id and m.organization_id = t.organization_id
     where tm.team_id = ${teamId} and t.organization_id = ${organizationId}
       and not (string_to_array(m.role, ',') && array['owner', 'admin'])
     order by u.name`)
  return (rows as { name: string }[]).map((r) => r.name)
}
