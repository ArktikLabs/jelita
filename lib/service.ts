import { sql } from 'drizzle-orm'
import { db } from './db'
import type { CurrencyCode } from './money'
import {
  clampPage, orderBy, paginate, toResult,
  type FilterRule, type ListQuery, type ListResult, type ListSpec,
} from './list-query'

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

export type PerformerCandidate = {
  userId: string
  name: string
  teamId: string
  branchName: string
  // Whether a service_staff row already exists for this (service, user) --
  // what pre-checks the box on the performers card.
  linked: boolean
}

export type CategoryRow = {
  id: string
  name: string
}

/** Categories of one salon, for grouping the list and populating the
 *  create form's select -- {id, name} only, nothing a client component
 *  doesn't render. */
export async function listCategories(organizationId: string): Promise<CategoryRow[]> {
  const { rows } = await db.execute(sql`
    select id, name from service_categories
     where organization_id = ${organizationId}
     order by name`)
  return (rows as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    name: r.name as string,
  }))
}

const rowsToServices = (rows: Record<string, unknown>[]): ServiceRow[] =>
  rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    categoryId: (r.category_id as string) ?? null,
    categoryName: (r.category_name as string) ?? null,
    durationMinutes: Number(r.duration_minutes),
    price: Number(r.price),
    active: r.active as boolean,
  }))

/**
 * Services of one salon, newest last -- unpaged. Pass serviceId to narrow to
 * one. The building block for getService and settings' "does this salon have
 * any services yet" check, neither of which wants a page of the catalogue.
 */
export async function servicesOf(
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
  return rowsToServices(rows as Record<string, unknown>[])
}

/**
 * What a URL may ask of the services list. `name` sorts on `lower(s.name)` to
 * match the existing `services_org_name_lower` unique index
 * (organization_id, lower(name)) -- a plain `s.name` sort would not use it.
 */
/**
 * Categories are per-salon rows, so there is no allow-list to declare --
 * the function form of FilterRule, same as STAFF_LIST's `branch`.
 *
 * Returning the raw id unvalidated is safe and deliberate: it reaches SQL
 * only as a bound parameter, and the query's own organization_id predicate
 * is what stops one salon narrowing to another's category. An id that
 * belongs to nobody matches nothing, which is the honest answer to asking
 * for a category that does not exist -- falling back to "no filter" would
 * show the whole catalogue to somebody who asked for one slice of it.
 *
 * `none` is a real value, not a placeholder: category_id is nullable and
 * the page groups those rows under "Tanpa kategori", so they need to be
 * selectable like any other group.
 */
const categoryFilter: FilterRule = (raw) => (raw === '' ? null : raw)

export const SERVICE_LIST: ListSpec<'name' | 'price'> = {
  sortable: { name: 'lower(s.name)', price: 's.price' },
  defaultSort: 'name',
  tiebreak: 's.id',
  searchable: true,
  // Services carries an `active` column same as customers -- undeclared
  // until Task 5's FilterBar needed a second resource to generalise from.
  filters: { active: ['true', 'false'], category: categoryFilter },
}

/**
 * One page of a salon's services. Flat, not grouped by category -- a page of
 * a grouped table has no single meaning, so the category is a plain column
 * here instead (the services page renders it that way).
 *
 * The count and the page query run in PARALLEL against the SAME `where`
 * fragment -- see listCustomers for why that pairing matters.
 */
export async function listServices(
  organizationId: string, query: ListQuery,
): Promise<ListResult<ServiceRow>> {
  const term = (query.q ?? '').trim()
  const like = `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`

  const where = sql`
    where s.organization_id = ${organizationId}
      ${term === '' ? sql`` : sql`and s.name ilike ${like}`}
      ${query.filters.active === undefined
        ? sql``
        : sql`and s.active = ${query.filters.active === 'true'}`}
      ${query.filters.category === undefined
        ? sql``
        : query.filters.category === 'none'
          ? sql`and s.category_id is null`
          : sql`and s.category_id = ${query.filters.category}`}`

  const fetch = async (q: ListQuery) => {
    const { rows } = await db.execute(sql`
      select s.id, s.name, s.category_id, c.name as category_name,
             s.duration_minutes, s.price, s.active
        from services s
        left join service_categories c
          on c.id = s.category_id and c.organization_id = s.organization_id
        ${where} ${orderBy(SERVICE_LIST, q)} ${paginate(q)}`)
    return rowsToServices(rows as Record<string, unknown>[])
  }

  const [rows, countRows] = await Promise.all([
    fetch(query),
    db.execute(sql`select count(*)::int as n from services s ${where}`),
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
 * A new service, guarded by the same currency race createServiceAction always
 * closed: `insert ... select ... for update` locks the salon_profiles row and
 * re-checks its currency inside the SAME statement, so a currency change that
 * wins the race leaves nothing inserted. `null` back means exactly that race
 * was lost -- the caller (createServiceAction) turns it into the "reload the
 * page" message; a thrown constraint violation still means the duplicate-name
 * index fired, same as before.
 */
export async function createService(input: {
  organizationId: string
  name: string
  durationMinutes: number
  price: number
  currency: CurrencyCode
  categoryId?: string | null
  actorUserId: string
}): Promise<{ id: string } | null> {
  const id = crypto.randomUUID()
  const { rowCount } = await db.execute(sql`
    insert into services (id, organization_id, category_id, name,
                          duration_minutes, price, created_by)
    select ${id}, ${input.organizationId}, ${input.categoryId ?? null},
           ${input.name}, ${input.durationMinutes}, ${input.price}, ${input.actorUserId}
      from salon_profiles
     where organization_id = ${input.organizationId} and currency = ${input.currency}
       for update`)
  return rowCount ? { id } : null
}

/** The detail screen's edit form -- same fields createServiceAction writes. */
export async function updateService(
  serviceId: string, organizationId: string,
  patch: { name: string; categoryId: string | null; durationMinutes: number; price: number },
  actorUserId: string,
): Promise<void> {
  await db.execute(sql`
    update services
       set name = ${patch.name}, category_id = ${patch.categoryId},
           duration_minutes = ${patch.durationMinutes}, price = ${patch.price},
           updated_by = ${actorUserId}
     where id = ${serviceId} and organization_id = ${organizationId}`)
}

/**
 * `active` stays the single truth for visibility -- this only stamps WHEN
 * and BY WHOM the service stopped being offered.
 *
 * Returns whether a row actually changed -- `returning id` the same way
 * deactivateBranch/deactivateStaff do -- so an id from another org, or one
 * that never existed, is reported honestly rather than rounded into "done"
 * (Fix 5, phase 4 review).
 */
export async function deactivateService(
  serviceId: string, organizationId: string, actorUserId: string,
): Promise<boolean> {
  const { rows } = await db.execute(sql`
    update services set active = false, deleted_at = now(), deleted_by = ${actorUserId}
     where id = ${serviceId} and organization_id = ${organizationId}
    returning id`)
  return rows.length > 0
}

/** A live row must not still claim a deletion date -- both deletion columns
 *  clear together; `updated_by` moves because reactivating is itself a
 *  change, even with no "reactivated_by" column of its own. */
export async function reactivateService(
  serviceId: string, organizationId: string, actorUserId: string,
): Promise<void> {
  await db.execute(sql`
    update services
       set active = true, deleted_at = null, deleted_by = null, updated_by = ${actorUserId}
     where id = ${serviceId} and organization_id = ${organizationId}`)
}

export async function salonCurrency(organizationId: string): Promise<CurrencyCode> {
  const { rows } = await db.execute(sql`
    select currency from salon_profiles where organization_id = ${organizationId}`)
  return ((rows[0] as { currency?: string })?.currency ?? 'IDR') as CurrencyCode
}

/** The salon-wide settings, for the one page that edits them and for the
 *  receipt and public page that render the branding. */
export async function salonSettings(organizationId: string) {
  const { rows } = await db.execute(sql`
    select currency, slot_minutes, logo_key, brand_color, auto_close_shift,
           points_kind, points_value,
           to_char(logo_updated_at, 'YYYYMMDDHH24MISS') as logo_version
      from salon_profiles where organization_id = ${organizationId}`)
  const r = rows[0] as Record<string, unknown> | undefined
  return {
    currency: ((r?.currency as string) ?? 'IDR') as CurrencyCode,
    slotMinutes: (r?.slot_minutes as number) ?? 30,
    hasLogo: Boolean(r?.logo_key),
    // Appended to /api/salon/logo so a new upload is a new URL -- which is
    // what lets that route cache immutably.
    logoVersion: (r?.logo_version as string) ?? '',
    brandColor: (r?.brand_color as string) ?? null,
    autoCloseShift: Boolean(r?.auto_close_shift),
    // Null means the salon runs no loyalty scheme -- distinct from zero.
    pointsKind: (r?.points_kind as string) ?? null,
    pointsValue: r?.points_value === null || r?.points_value === undefined
      ? null
      : Number(r.points_value),
  }
}

/**
 * Eligible performers for one service: staff_profiles with a branch
 * assignment (team_id is not null) who are active. This is the same list
 * setPerformersAction iterates to build the checked set from a submit, so a
 * performer-<id> field naming staff outside it is simply never looked up.
 *
 * Spec §8's known gap lives here: owners and admins have team_id null by the
 * staff model, so a working owner who cuts hair cannot be linked to a
 * service and will not be bookable. Fixing it needs a staff-model change
 * (a branch assignment that does not count as "assigned staff" for branch
 * deactivation) and is deferred deliberately -- do not work around it here.
 */
export async function listPerformers(
  serviceId: string, organizationId: string,
): Promise<PerformerCandidate[]> {
  const { rows } = await db.execute(sql`
    select sp.user_id, u.name, sp.team_id, t.name as branch_name,
           exists (
             select 1 from service_staff ss
              where ss.service_id = ${serviceId} and ss.user_id = sp.user_id
                and ss.organization_id = sp.organization_id
           ) as linked
      from staff_profiles sp
      join users u on u.id = sp.user_id
      join teams t on t.id = sp.team_id and t.organization_id = sp.organization_id
     where sp.organization_id = ${organizationId}
       and sp.team_id is not null and sp.active
     order by u.name, u.id`)
  return (rows as Record<string, unknown>[]).map((r) => ({
    userId: r.user_id as string,
    name: r.name as string,
    teamId: r.team_id as string,
    branchName: r.branch_name as string,
    linked: r.linked as boolean,
  }))
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
): Promise<{
  service: ServiceRow; overrides: OverrideRow[]; performers: PerformerCandidate[]
  audit: {
    createdByName: string | null; createdAt: string
    updatedByName: string | null; updatedAt: string
    deletedByName: string | null; deletedAt: string | null
  }
} | null> {
  const [service] = await servicesOf(organizationId, serviceId)
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

  const performers = await listPerformers(serviceId, organizationId)

  // Task 4's audit trail (spec §5). No fallback for a null created_by here:
  // unlike customers' public booking page, every write path into `services`
  // requires a signed-in actor (createService's `actorUserId: string`), so a
  // null one only ever comes from the seed script -- no context worth naming.
  const { rows: auditRows } = await db.execute(sql`
    select cb.name as created_by_name, to_char(s.created_at, 'DD-MM-YYYY') as created_display,
           ub.name as updated_by_name, to_char(s.updated_at, 'DD-MM-YYYY') as updated_display,
           (s.updated_by is not null and (
             s.updated_by is distinct from s.created_by
             or extract(epoch from s.updated_at - s.created_at) > 10
           )) as show_updated,
           delb.name as deleted_by_name, to_char(s.deleted_at, 'DD-MM-YYYY') as deleted_display
      from services s
      left join users cb on cb.id = s.created_by
      left join users ub on ub.id = s.updated_by
      left join users delb on delb.id = s.deleted_by
     where s.id = ${serviceId} and s.organization_id = ${organizationId}`)
  const a = auditRows[0] as Record<string, unknown>
  const audit = {
    createdByName: (a.created_by_name as string) ?? null,
    createdAt: a.created_display as string,
    updatedByName: a.show_updated ? (a.updated_by_name as string) : null,
    updatedAt: a.updated_display as string,
    deletedByName: (a.deleted_by_name as string) ?? null,
    deletedAt: (a.deleted_display as string) ?? null,
  }

  return { service, overrides, performers, audit }
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
