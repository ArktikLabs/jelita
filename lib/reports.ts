import { sql, type SQL } from 'drizzle-orm'
import { db } from './db'

/**
 * PRD §5.6's figures. READ ONLY -- this module adds no write path, which is
 * why the reports slice came last: nothing else was going to change shape
 * underneath it.
 *
 * Every function takes an optional `staffUserId`. When set, the figures narrow
 * to that stylist, which is how a stylist sees the same dashboard about their
 * own work (spec 2.1). ONE FILTER rather than a second query set: two sets over
 * the same rows are two chances to disagree, and the one a stylist saw would be
 * the one nobody checked.
 *
 * `to` is INCLUSIVE -- callers pass the last day they mean, and the day is
 * added here. Doing that at each call site is how one report ends up a day
 * short of another.
 */

export type Scope = {
  organizationId: string
  teamId: string
  from: string
  /** Inclusive. */
  to: string
  staffUserId?: string | null
}

const upto = (to: string) => sql`(${to}::date + 1)`

const onlyStaff = (staffUserId?: string | null): SQL =>
  (staffUserId ? sql`and l.staff_user_id = ${staffUserId}` : sql``)

/** A line's net money, signed by its own amounts so a reversal subtracts. */
const lineNet = sql`(l.unit_price * l.quantity - l.discount)`

/**
 * A line's net COUNT, and the one place in this slice where the obvious query
 * is wrong.
 *
 * A reversal's line carries a negative unit_price and a POSITIVE quantity -- it
 * has to, because `transaction_lines_quantity` is `check (quantity > 0)` and a
 * quantity counts what was performed rather than being a signed amount. So
 * `sum(quantity)` counts a voided service twice, once performed and once
 * returned, and "top services by volume" would rank the most-voided service
 * highest.
 *
 * Signed by `reverses_id`, exactly as stock movements and points are.
 */
const lineCount = sql`(case when t.reverses_id is null then l.quantity else -l.quantity end)`

const settled = (s: Scope) => sql`
  t.organization_id = ${s.organizationId} and t.team_id = ${s.teamId}
    and t.status <> 'open'
    and t.completed_at >= ${s.from}::date and t.completed_at < ${upto(s.to)}`

/**
 * Revenue for the range.
 *
 * UNSCOPED reads transaction totals -- which include retail lines and any
 * order-level discount, so it is the salon's actual takings.
 *
 * SCOPED reads line nets instead, because a transaction's total is not any one
 * stylist's: it may carry a colleague's service, a bottle of shampoo, and a
 * discount applied to the whole sale. The two figures will NOT agree for the
 * same range, and that is correct rather than a bug for someone to "fix".
 */
export async function revenueRange(s: Scope): Promise<number> {
  const { rows } = s.staffUserId
    ? await db.execute(sql`
        select coalesce(sum(${lineNet}), 0)::bigint as revenue
          from transaction_lines l
          join transactions t on t.id = l.transaction_id
         where ${settled(s)} ${onlyStaff(s.staffUserId)}`)
    : await db.execute(sql`
        select coalesce(sum(t.total), 0)::bigint as revenue
          from transactions t
         where ${settled(s)}`)
  return Number((rows[0] as { revenue: string }).revenue)
}

/**
 * Revenue per day, with EVERY day in the range present.
 *
 * `generate_series` on the left, so a quiet Sunday is a zero rather than a
 * missing point -- a trend line that skips empty days lies about its own shape,
 * drawing a straight run where the salon was shut.
 */
export async function revenueByDay(
  s: Scope,
): Promise<{ day: string; revenue: number }[]> {
  const { rows } = await db.execute(sql`
    with days as (
      select generate_series(${s.from}::date, ${s.to}::date, interval '1 day')::date as day
    ),
    takings as (
      ${s.staffUserId
        ? sql`select t.completed_at::date as day, sum(${lineNet}) as revenue
                 from transaction_lines l
                 join transactions t on t.id = l.transaction_id
                where ${settled(s)} ${onlyStaff(s.staffUserId)}
                group by 1`
        : sql`select t.completed_at::date as day, sum(t.total) as revenue
                 from transactions t
                where ${settled(s)}
                group by 1`}
    )
    select to_char(d.day, 'YYYY-MM-DD') as day,
           coalesce(k.revenue, 0)::bigint as revenue
      from days d left join takings k on k.day = d.day
     order by d.day`)
  return (rows as Record<string, unknown>[]).map((r) => ({
    day: r.day as string,
    revenue: Number(r.revenue),
  }))
}

export type ServiceRank = { name: string; revenue: number; count: number }

/**
 * §5.6's "top 5 services by revenue and by volume".
 *
 * One query, both orderings taken from it -- the ranks come from the same rows,
 * so the two tables cannot disagree about what a service earned.
 *
 * Service lines only. A retail product is not a service, and §5.6 asks about
 * services.
 */
export async function topServices(
  s: Scope, limit = 5,
): Promise<{ byRevenue: ServiceRank[]; byCount: ServiceRank[] }> {
  const { rows } = await db.execute(sql`
    select l.name,
           coalesce(sum(${lineNet}), 0)::bigint as revenue,
           coalesce(sum(${lineCount}), 0)::int as count
      from transaction_lines l
      join transactions t on t.id = l.transaction_id
     where ${settled(s)} and l.kind = 'service' ${onlyStaff(s.staffUserId)}
     group by l.name`)
  const all = (rows as Record<string, unknown>[]).map((r) => ({
    name: r.name as string,
    revenue: Number(r.revenue),
    count: Number(r.count),
  }))
  return {
    byRevenue: [...all].sort((a, b) => b.revenue - a.revenue).slice(0, limit),
    byCount: [...all].sort((a, b) => b.count - a.count).slice(0, limit),
  }
}

export type StaffRank = {
  staffUserId: string
  name: string
  revenue: number
  services: number
  commission: number
}

/**
 * §5.6's staff performance: revenue generated, services completed, commission
 * earned.
 *
 * A PRODUCT line has no `staff_user_id`, so it cannot become a row here --
 * which is right, since retail is nobody's service and earns no commission
 * either (commissions spec, out of scope).
 *
 * The commission column is summed from `commissions` rather than recomputed,
 * so it is the same number payroll pays on. tests/reports.db.test.ts asserts
 * it equals commissionRecap over the same window -- two queries over the same
 * rows disagreeing is the failure this slice could most easily hide.
 */
export async function staffPerformance(s: Scope): Promise<StaffRank[]> {
  const { rows } = await db.execute(sql`
    with work as (
      select l.staff_user_id,
             sum(${lineNet}) as revenue,
             sum(${lineCount}) as services
        from transaction_lines l
        join transactions t on t.id = l.transaction_id
       where ${settled(s)} and l.staff_user_id is not null
         ${onlyStaff(s.staffUserId)}
       group by 1
    ),
    earned as (
      select c.staff_user_id, sum(c.amount) as commission
        from commissions c
        join transactions t on t.id = c.transaction_id
       where ${settled(s)}
       group by 1
    )
    select u.id as staff_user_id, u.name,
           coalesce(w.revenue, 0)::bigint as revenue,
           coalesce(w.services, 0)::int as services,
           coalesce(e.commission, 0)::bigint as commission
      from work w
      full join earned e on e.staff_user_id = w.staff_user_id
      join users u on u.id = coalesce(w.staff_user_id, e.staff_user_id)
     order by coalesce(w.revenue, 0) desc, u.name`)
  return (rows as Record<string, unknown>[]).map((r) => ({
    staffUserId: r.staff_user_id as string,
    name: r.name as string,
    revenue: Number(r.revenue),
    services: Number(r.services),
    commission: Number(r.commission),
  }))
}

export type Funnel = {
  total: number
  completed: number
  cancelled: number
  noShow: number
  /** Percentages, 0-100, rounded. Zero on an empty range rather than NaN. */
  completionRate: number
  noShowRate: number
}

/**
 * §5.6's booking funnel.
 *
 * Counted by `starts_at`, not by when the booking was made: "what happened to
 * last week's appointments" is the question, and a booking made in March for a
 * June slot belongs to June.
 *
 * Cancellations stay in the denominator. A cancellation is an outcome, and
 * leaving it out would flatter the completion rate.
 */
export async function bookingFunnel(s: Scope): Promise<Funnel> {
  const { rows } = await db.execute(sql`
    select count(*)::int as total,
           count(*) filter (where b.status = 'completed')::int as completed,
           count(*) filter (where b.status = 'cancelled')::int as cancelled,
           count(*) filter (where b.status = 'no_show')::int as no_show
      from bookings b
     where b.organization_id = ${s.organizationId} and b.team_id = ${s.teamId}
       and b.starts_at >= ${s.from}::date and b.starts_at < ${upto(s.to)}
       ${s.staffUserId ? sql`and b.staff_user_id = ${s.staffUserId}` : sql``}`)
  const r = rows[0] as Record<string, number>
  const total = Number(r.total)
  // Zero, not NaN: an empty range is a normal thing to look at, and a division
  // by zero would reach the screen as "NaN%".
  const pct = (n: number) => (total === 0 ? 0 : Math.round((n / total) * 100))
  return {
    total,
    completed: Number(r.completed),
    cancelled: Number(r.cancelled),
    noShow: Number(r.no_show),
    completionRate: pct(Number(r.completed)),
    noShowRate: pct(Number(r.no_show)),
  }
}
