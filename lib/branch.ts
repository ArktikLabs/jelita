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
}

/**
 * One page of a salon's branches.
 *
 * The count query is against `teams` alone: every column the `where`
 * fragment touches lives there, and teams<->branch_profiles is 1:1 (every
 * team is seeded exactly one profile row), so joining branch_profiles into
 * the count would cost a join for no change in the number.
 */
export async function listBranches(
  organizationId: string, query: ListQuery,
): Promise<ListResult<BranchRow>> {
  const term = (query.q ?? '').trim()
  const like = `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`

  const where = sql`
    where t.organization_id = ${organizationId}
      ${term === '' ? sql`` : sql`and t.name ilike ${like}`}`

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
    db.execute(sql`select count(*)::int as n from teams t ${where}`),
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
  return { profile, hours }
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
