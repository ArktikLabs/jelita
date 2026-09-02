import { sql } from 'drizzle-orm'
import { db } from './db'

export type ScheduleDay = {
  weekday: number
  closed: boolean
  opensAt: string
  closesAt: string
}

export type ScheduleException = {
  onDate: string
  closed: boolean
  opensAt: string | null
  closesAt: string | null
  note: string | null
}

export type TimeOffBlock = {
  id: string
  onDate: string
  startsAt: string
  endsAt: string
  note: string | null
}

const hhmm = (v: unknown) => String(v).slice(0, 5)

/** The weekly pattern, Sunday first, matching extract(dow). */
export async function staffSchedule(
  userId: string, organizationId: string,
): Promise<ScheduleDay[]> {
  const { rows } = await db.execute(sql`
    select weekday, closed, opens_at, closes_at from staff_hours
     where user_id = ${userId} and organization_id = ${organizationId}
     order by weekday`)
  return (rows as Record<string, unknown>[]).map((r) => ({
    weekday: Number(r.weekday),
    closed: r.closed as boolean,
    opensAt: hhmm(r.opens_at),
    closesAt: hhmm(r.closes_at),
  }))
}

/**
 * Exceptions from today forward. Past ones are kept, never shown: a booking
 * made under one is explained by it, so deleting them would erase the reason
 * an old appointment exists.
 */
export async function upcomingExceptions(
  userId: string, organizationId: string,
): Promise<ScheduleException[]> {
  const { rows } = await db.execute(sql`
    select on_date, closed, opens_at, closes_at, note
      from staff_schedule_exceptions
     where user_id = ${userId} and organization_id = ${organizationId}
       and on_date >= current_date
     order by on_date`)
  return (rows as Record<string, unknown>[]).map((r) => ({
    onDate: String(r.on_date).slice(0, 10),
    closed: r.closed as boolean,
    opensAt: r.opens_at ? hhmm(r.opens_at) : null,
    closesAt: r.closes_at ? hhmm(r.closes_at) : null,
    note: (r.note as string) ?? null,
  }))
}

export async function upcomingTimeOff(
  userId: string, organizationId: string,
): Promise<TimeOffBlock[]> {
  const { rows } = await db.execute(sql`
    select id, on_date, starts_at, ends_at, note from staff_time_off
     where user_id = ${userId} and organization_id = ${organizationId}
       and on_date >= current_date
     order by on_date, starts_at`)
  return (rows as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    onDate: String(r.on_date).slice(0, 10),
    startsAt: hhmm(r.starts_at),
    endsAt: hhmm(r.ends_at),
    note: (r.note as string) ?? null,
  }))
}

/**
 * The effective working interval(s) for one date -- what booking calls.
 *
 * Returns an ARRAY, and callers iterate, even though the function can only
 * yield zero or one row today (spec 2.4). That costs a loop running once and
 * means adding intervals per weekday later never touches slot generation.
 * Do not collapse this to a single value before that option is spent.
 */
export async function workingHours(
  userId: string, organizationId: string, onDate: string,
): Promise<{ opensAt: string; closesAt: string }[]> {
  const { rows } = await db.execute(sql`
    select opens_at, closes_at
      from staff_working_hours(${userId}, ${organizationId}, ${onDate}::date)`)
  return (rows as Record<string, unknown>[]).map((r) => ({
    opensAt: hhmm(r.opens_at),
    closesAt: hhmm(r.closes_at),
  }))
}
