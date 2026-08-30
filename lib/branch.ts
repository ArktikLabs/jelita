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

export async function listBranches(organizationId: string): Promise<BranchRow[]> {
  const { rows } = await db.execute(sql`
    select t.id as team_id, t.name, p.address, p.phone, p.active,
           coalesce(e.within_cap, false) as within_cap, t.member_count
      from teams t
      join branch_profiles p on p.team_id = t.id
      left join branch_entitlement e on e.team_id = t.id
     where t.organization_id = ${organizationId}
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

export async function getBranch(teamId: string) {
  const [profile] = await listBranchesById(teamId)
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

async function listBranchesById(teamId: string): Promise<BranchRow[]> {
  const { rows } = await db.execute(sql`
    select t.id as team_id, t.name, p.address, p.phone, p.active,
           coalesce(e.within_cap, false) as within_cap, t.member_count
      from teams t
      join branch_profiles p on p.team_id = t.id
      left join branch_entitlement e on e.team_id = t.id
     where t.id = ${teamId} limit 1`)
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
