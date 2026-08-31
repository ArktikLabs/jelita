import { sql } from 'drizzle-orm'
import { db } from './db'
import type { CurrencyCode } from './money'

export type ServiceRow = {
  id: string
  name: string
  categoryId: string | null
  categoryName: string | null
  durationMinutes: number
  price: number
  active: boolean
}

export type OverrideRow = {
  teamId: string
  branchName: string
  // null means INHERITS the salon price -- must survive to the form field
  // as an empty input, not a re-typed copy of the salon price.
  price: number | null
  offered: boolean
}

export type PerformerRow = {
  userId: string
  name: string
  teamId: string | null
  branchName: string | null
}

/** Services of one salon, newest last. Pass serviceId to narrow to one. */
export async function listServices(
  organizationId: string, serviceId?: string,
): Promise<ServiceRow[]> {
  const { rows } = await db.execute(sql`
    select s.id, s.name, s.category_id, c.name as category_name,
           s.duration_minutes, s.price, s.active
      from services s
      left join service_categories c
        on c.id = s.category_id and c.organization_id = s.organization_id
     where s.organization_id = ${organizationId}
       ${serviceId === undefined ? sql`` : sql`and s.id = ${serviceId}`}
     order by c.name nulls last, s.name`)
  return (rows as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    categoryId: (r.category_id as string) ?? null,
    categoryName: (r.category_name as string) ?? null,
    durationMinutes: Number(r.duration_minutes),
    price: Number(r.price),
    active: r.active as boolean,
  }))
}

export async function salonCurrency(organizationId: string): Promise<CurrencyCode> {
  const { rows } = await db.execute(sql`
    select currency from salon_profiles where organization_id = ${organizationId}`)
  return ((rows[0] as { currency?: string })?.currency ?? 'IDR') as CurrencyCode
}

/**
 * One service plus, for the detail/edit screen: every branch of the salon
 * with its override (or the absence of one), and everyone who can perform
 * it. A branch with no override row still gets an entry -- price: null,
 * offered: true -- so the form can render every branch and null reaches the
 * price field as an empty input, not a stored row's absence.
 */
export async function getService(
  serviceId: string, organizationId: string,
): Promise<{ service: ServiceRow; overrides: OverrideRow[]; performers: PerformerRow[] } | null> {
  const [service] = await listServices(organizationId, serviceId)
  if (!service) return null

  const { rows: overrideRows } = await db.execute(sql`
    select t.id as team_id, t.name as branch_name, o.price,
           coalesce(o.offered, true) as offered
      from teams t
      left join service_branch_overrides o
        on o.service_id = ${serviceId} and o.team_id = t.id
       and o.organization_id = t.organization_id
     where t.organization_id = ${organizationId}
     order by t.name, t.id`)
  const overrides = (overrideRows as Record<string, unknown>[]).map((r) => ({
    teamId: r.team_id as string,
    branchName: r.branch_name as string,
    price: r.price === null || r.price === undefined ? null : Number(r.price),
    offered: r.offered as boolean,
  }))

  const { rows: performerRows } = await db.execute(sql`
    select u.id as user_id, u.name, sp.team_id, t.name as branch_name
      from service_staff ss
      join users u on u.id = ss.user_id
      left join staff_profiles sp
        on sp.user_id = ss.user_id and sp.organization_id = ss.organization_id
      left join teams t on t.id = sp.team_id
     where ss.service_id = ${serviceId} and ss.organization_id = ${organizationId}
     order by u.name, u.id`)
  const performers = (performerRows as Record<string, unknown>[]).map((r) => ({
    userId: r.user_id as string,
    name: r.name as string,
    teamId: (r.team_id as string) ?? null,
    branchName: (r.branch_name as string) ?? null,
  }))

  return { service, overrides, performers }
}

/**
 * The effective price of a service at a branch. Booking, POS and commission
 * all call this. It selects from service_branch_pricing rather than repeating
 * the coalesce -- three inline copies would drift, and the view is also what
 * scripts/service-check.mjs asserts against, so the app and the tests exercise
 * the same logic.
 */
export async function resolveService(
  serviceId: string, teamId: string, organizationId: string,
) {
  const { rows } = await db.execute(sql`
    select price, currency, offered, duration_minutes
      from service_branch_pricing
     where service_id = ${serviceId} and team_id = ${teamId}
       and organization_id = ${organizationId}`)
  const r = rows[0] as Record<string, unknown> | undefined
  if (!r) return null
  return {
    price: Number(r.price),
    currency: r.currency as CurrencyCode,
    offered: r.offered as boolean,
    durationMinutes: Number(r.duration_minutes),
  }
}
