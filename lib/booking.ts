import { sql } from 'drizzle-orm'
import { db } from './db'
import { pgCode } from './pg-error'

/**
 * The single authority every booking path routes through -- the internal form
 * now, the public page next slice -- the way provisionStaff is for staff.
 *
 * Two things live here rather than in available_slots, and both are here so
 * that no caller can forget them: dropping starts in the past, and treating a
 * lost race exactly like a stale page.
 */

/** 'YYYY-MM-DDTHH:MM' -- wall-clock, no zone. See the timezone note below. */
export type SlotTime = string

export type Slot = { startsAt: SlotTime; staffUserId: string }

export type BookingRow = {
  id: string
  startsAt: SlotTime
  endsAt: SlotTime
  staffUserId: string
  staffName: string
  customerName: string
  serviceName: string
  status: string
  price: number
  currency: string
}

/**
 * Times are wall-clock throughout: the salon and its customers are in one
 * timezone (spec 2.6), starts_at is `timestamp` not `timestamptz`, and
 * staff_working_hours returns bare `time`. Carrying them as 'YYYY-MM-DDTHH:MM'
 * strings rather than Date keeps the process's own zone out of it entirely --
 * a Date would be parsed and re-serialised against TZ at every hop, and the
 * one place the app compares to a clock is here.
 */
const PAD = (n: number) => String(n).padStart(2, '0')

const nowLocal = (): SlotTime => {
  const d = new Date()
  return `${d.getFullYear()}-${PAD(d.getMonth() + 1)}-${PAD(d.getDate())}`
    + `T${PAD(d.getHours())}:${PAD(d.getMinutes())}`
}

/**
 * Postgres exclusion_violation -- bookings_no_overlap rejecting an overlap.
 *
 * Read through pgCode, which walks `cause`: drizzle wraps a driver error in a
 * DrizzleQueryError carrying the original underneath, so reading `.code` off
 * the top level alone never matches and the retry below can never fire. That
 * was a real bug here once.
 */
const isSlotTaken = (e: unknown) => pgCode(e) === '23P01'

type SlotQuery = {
  organizationId: string
  teamId: string
  serviceId: string
  date: string
  /** null asks for "any available" -- every qualified stylist. */
  staffUserId?: string | null
  /** Walk-ins only: keep starts that have already passed today (spec 9). */
  includePast?: boolean
  /** Rescheduling: the booking being moved must not count itself as busy. */
  excludeBookingId?: string | null
}

/**
 * available_slots minus starts already in the past.
 *
 * The past filter is NOT in the SQL function: keeping it out leaves that
 * function pure over its arguments, so its tests never fight the clock, and
 * putting it here means the slot list and the create path cannot disagree
 * about it (spec 4).
 *
 * `includePast` is the walk-in bypass: someone standing at the counter at
 * 10:05 is booked for 10:00, and refusing that would make the front desk lie
 * about when the appointment started. Never set from a public request -- a
 * stranger booking yesterday is not a use case, it is a bug.
 */
export async function listSlots(q: SlotQuery): Promise<Slot[]> {
  const { rows } = await db.execute(sql`
    select to_char(starts_at, 'YYYY-MM-DD"T"HH24:MI') as starts_at, staff_user_id
      from available_slots(${q.organizationId}, ${q.teamId}, ${q.serviceId},
                           ${q.date}::date, ${q.staffUserId ?? null},
                           ${q.excludeBookingId ?? null})`)
  const now = nowLocal()
  return (rows as Record<string, unknown>[])
    .map((r) => ({ startsAt: r.starts_at as string, staffUserId: r.staff_user_id as string }))
    .filter((s) => q.includePast || s.startsAt > now)
}

/** Distinct start times, for a picker that has not chosen a stylist yet. */
export const slotTimes = (slots: Slot[]): SlotTime[] =>
  [...new Set(slots.map((s) => s.startsAt))].sort()

/** How many bookings each stylist already holds that day -- the "any
 *  available" tie-break, so the fifth customer does not all land on one
 *  person while a colleague sits idle. */
async function loadPerStylist(organizationId: string, teamId: string, date: string) {
  const { rows } = await db.execute(sql`
    select staff_user_id, count(*)::int as n from bookings
     where organization_id = ${organizationId} and team_id = ${teamId}
       and starts_at >= ${date}::date and starts_at < ${date}::date + 1
       and status in ('pending', 'confirmed')
     group by staff_user_id`)
  return new Map((rows as Record<string, unknown>[])
    .map((r) => [r.staff_user_id as string, r.n as number]))
}

/**
 * Writes one booking, snapshotting duration, price and currency FROM THE SAME
 * STATEMENT that writes them -- a separate read then write could snapshot a
 * price that changed in between.
 *
 * Returns null when service_branch_pricing offers nothing (the service is not
 * sold at this branch), and throws on an overlap.
 */
async function insertBooking(input: {
  organizationId: string; teamId: string; serviceId: string; customerId: string
  staffUserId: string; startsAt: SlotTime; note?: string | null
  status?: 'pending' | 'confirmed'
}) {
  const id = crypto.randomUUID()
  const { rows } = await db.execute(sql`
    insert into bookings (id, organization_id, team_id, staff_user_id, customer_id,
                          service_id, starts_at, ends_at, status,
                          duration_minutes, price, currency, note)
    select ${id}, ${input.organizationId}, ${input.teamId}, ${input.staffUserId},
           ${input.customerId}, ${input.serviceId},
           ${input.startsAt}::timestamp,
           ${input.startsAt}::timestamp + make_interval(mins => p.duration_minutes),
           ${input.status ?? 'pending'}, p.duration_minutes, p.price, p.currency,
           ${input.note ?? null}
      from service_branch_pricing p
     where p.service_id = ${input.serviceId} and p.team_id = ${input.teamId}
       and p.organization_id = ${input.organizationId} and p.offered
    returning id`)
  return (rows[0] as { id?: string } | undefined)?.id ?? null
}

/**
 * Book it.
 *
 * The client's slot list is never trusted: availability is recomputed and the
 * requested pair must appear in it. Then the exclusion constraint is the real
 * arbiter, because two requests can both pass that recheck before either
 * writes. Both report SLOT_TAKEN on purpose -- a stale page and a lost race
 * are indistinguishable to the person booking, and both mean "pick another
 * time" (spec 5).
 */
export async function createBooking(input: {
  organizationId: string
  teamId: string
  serviceId: string
  customerId: string
  date: string
  startsAt: SlotTime
  /** null means "any available" -- assigned here, never stored as a choice. */
  staffUserId?: string | null
  note?: string | null
  /** Walk-ins only. See listSlots. */
  includePast?: boolean
  /** Public bookings land `pending`; the salon confirms (spec 2.7). A walk-in
   *  is already standing there, so the front desk books it confirmed. */
  status?: 'pending' | 'confirmed'
}): Promise<string> {
  const slots = await listSlots(input)
  const free = slots.filter((s) => s.startsAt === input.startsAt)
  if (free.length === 0) throw new Error('SLOT_TAKEN')

  let candidates = free.map((s) => s.staffUserId)
  if (input.staffUserId) {
    // Named: available_slots was already narrowed to them, so a non-empty
    // `free` means they are free. Guarded anyway -- a caller passing a stylist
    // who does not appear must not silently book someone else.
    if (!candidates.includes(input.staffUserId)) throw new Error('SLOT_TAKEN')
    candidates = [input.staffUserId]
  } else {
    const load = await loadPerStylist(input.organizationId, input.teamId, input.date)
    candidates.sort((a, b) => (load.get(a) ?? 0) - (load.get(b) ?? 0) || a.localeCompare(b))
  }

  // Retrying is the whole reason this loop exists. Two customers picking "any
  // available" at the same instant with two free stylists must BOTH succeed --
  // failing the second is a bug they experience as a fully-booked salon that
  // is not. Bounded by the candidate list, so it terminates.
  for (const staffUserId of candidates) {
    try {
      const id = await insertBooking({ ...input, staffUserId })
      if (id) return id
      // No pricing row: the service is not offered at this branch. Every
      // candidate would hit the same wall, so stop rather than loop.
      throw new Error('NOT_OFFERED')
    } catch (e) {
      if (!isSlotTaken(e)) throw e
    }
  }
  throw new Error('SLOT_TAKEN')
}

/**
 * What this branch actually sells, with the terms a booking will snapshot.
 * Reads the view, so `offered` already folds in the service's own active flag
 * and the price is the branch's override where one exists.
 */
export async function bookableServices(organizationId: string, teamId: string) {
  const { rows } = await db.execute(sql`
    select p.service_id, s.name, p.duration_minutes, p.price, p.currency
      from service_branch_pricing p
      join services s on s.id = p.service_id
     where p.organization_id = ${organizationId} and p.team_id = ${teamId}
       and p.offered
     order by s.name, s.id`)
  return (rows as Record<string, unknown>[]).map((r) => ({
    serviceId: r.service_id as string,
    name: r.name as string,
    durationMinutes: r.duration_minutes as number,
    price: Number(r.price),
    currency: r.currency as string,
  }))
}

/** One booking, scoped by organizationId in the query itself so a bare id
 *  cannot cross tenants. */
export async function getBooking(bookingId: string, organizationId: string) {
  const { rows } = await db.execute(sql`
    select b.id, b.team_id, b.service_id, b.staff_user_id, b.customer_id, b.status,
           to_char(b.starts_at, 'YYYY-MM-DD"T"HH24:MI') as starts_at,
           b.duration_minutes, s.name as service_name, c.name as customer_name
      from bookings b
      join services s on s.id = b.service_id
      join customers c on c.id = b.customer_id
     where b.id = ${bookingId} and b.organization_id = ${organizationId}`)
  const r = rows[0] as Record<string, unknown> | undefined
  if (!r) return null
  return {
    id: r.id as string,
    teamId: r.team_id as string,
    serviceId: r.service_id as string,
    staffUserId: r.staff_user_id as string,
    // The id, not just the name: checkout attaches its sale to the same member
    // record rather than looking one up again by name.
    customerId: r.customer_id as string,
    status: r.status as string,
    startsAt: r.starts_at as string,
    durationMinutes: r.duration_minutes as number,
    serviceName: r.service_name as string,
    customerName: r.customer_name as string,
  }
}

/** One branch's day, in time order -- the whole of /dashboard/bookings. */
export async function listBookings(
  organizationId: string, teamId: string, date: string,
): Promise<BookingRow[]> {
  const { rows } = await db.execute(sql`
    select b.id,
           to_char(b.starts_at, 'YYYY-MM-DD"T"HH24:MI') as starts_at,
           to_char(b.ends_at, 'YYYY-MM-DD"T"HH24:MI') as ends_at,
           b.staff_user_id, u.name as staff_name, c.name as customer_name,
           s.name as service_name, b.status, b.price, b.currency
      from bookings b
      join users u on u.id = b.staff_user_id
      join customers c on c.id = b.customer_id
      join services s on s.id = b.service_id
     where b.organization_id = ${organizationId} and b.team_id = ${teamId}
       and b.starts_at >= ${date}::date and b.starts_at < ${date}::date + 1
     order by b.starts_at, u.name`)
  return (rows as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    startsAt: r.starts_at as string,
    endsAt: r.ends_at as string,
    staffUserId: r.staff_user_id as string,
    staffName: r.staff_name as string,
    customerName: r.customer_name as string,
    serviceName: r.service_name as string,
    status: r.status as string,
    price: Number(r.price),
    currency: r.currency as string,
  }))
}

/**
 * A date RANGE of one branch's bookings, for the calendar. `to` is exclusive.
 *
 * Same shape as listBookings, plus the day, so a week grid can bucket by it
 * without re-parsing every start.
 */
export async function listBookingsBetween(
  organizationId: string, teamId: string, from: string, to: string,
): Promise<(BookingRow & { day: string })[]> {
  const { rows } = await db.execute(sql`
    select b.id,
           to_char(b.starts_at, 'YYYY-MM-DD"T"HH24:MI') as starts_at,
           to_char(b.ends_at, 'YYYY-MM-DD"T"HH24:MI') as ends_at,
           to_char(b.starts_at, 'YYYY-MM-DD') as day,
           b.staff_user_id, u.name as staff_name, c.name as customer_name,
           s.name as service_name, b.status, b.price, b.currency
      from bookings b
      join users u on u.id = b.staff_user_id
      join customers c on c.id = b.customer_id
      join services s on s.id = b.service_id
     where b.organization_id = ${organizationId} and b.team_id = ${teamId}
       and b.starts_at >= ${from}::date and b.starts_at < ${to}::date
     order by b.starts_at, u.name`)
  return (rows as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    startsAt: r.starts_at as string,
    endsAt: r.ends_at as string,
    day: r.day as string,
    staffUserId: r.staff_user_id as string,
    staffName: r.staff_name as string,
    customerName: r.customer_name as string,
    serviceName: r.service_name as string,
    status: r.status as string,
    price: Number(r.price),
    currency: r.currency as string,
  }))
}

/**
 * The widest open window across a date range, as minutes from midnight.
 *
 * The calendar's vertical bounds. Derived from branch_hours rather than
 * hardcoded: a salon open 10:00-20:00 would otherwise stare at hours of dead
 * grid, and one opening at 07:00 would have its first appointments CLIPPED off
 * the top -- dead space is ugly, clipping is wrong.
 *
 * Null when the branch is closed every day in the range.
 */
export async function branchOpenWindow(
  teamId: string, from: string, to: string,
): Promise<{ startMin: number; endMin: number } | null> {
  const { rows } = await db.execute(sql`
    select min(extract(epoch from h.opens_at) / 60)::int as start_min,
           max(extract(epoch from h.closes_at) / 60)::int as end_min
      from generate_series(${from}::date, ${to}::date - 1, interval '1 day') d
      join branch_hours h
        on h.team_id = ${teamId}
       and h.weekday = extract(dow from d)::smallint
     where not h.closed`)
  const r = rows[0] as { start_min: number | null; end_min: number | null } | undefined
  if (!r || r.start_min === null || r.end_min === null) return null
  return { startMin: r.start_min, endMin: r.end_min }
}

/** pending -> confirmed | cancelled; confirmed -> completed | no_show | cancelled. */
const NEXT: Record<string, string[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['completed', 'no_show', 'cancelled'],
  completed: [],
  cancelled: [],
  no_show: [],
}

/**
 * Scoped by organizationId in the statement, so a bare id cannot cross
 * tenants, and gated on the CURRENT status in the same statement, so two
 * concurrent transitions cannot both apply.
 */
export async function setBookingStatus(
  bookingId: string, organizationId: string, status: string,
): Promise<void> {
  const from = Object.keys(NEXT).filter((s) => NEXT[s].includes(status))
  if (from.length === 0) throw new Error('BAD_STATUS')
  const { rows } = await db.execute(sql`
    update bookings set status = ${status}, updated_at = now()
     where id = ${bookingId} and organization_id = ${organizationId}
       and status in ${sql`(${sql.join(from.map((s) => sql`${s}`), sql`, `)})`}
    returning id`)
  if (rows.length === 0) throw new Error('BAD_TRANSITION')
}

/**
 * Move a booking to a different time, or a different stylist, or both.
 *
 * Not a cancel-and-rebook: the row keeps its id, so the customer's reference,
 * its history and anything that later points at it survive the move.
 *
 * The terms do NOT move with it. `duration_minutes` and `price` were agreed
 * when the booking was made (engine spec 2.5), so `ends_at` is recomputed from
 * the STORED duration rather than the service's current one -- a service that
 * grew from 60 to 90 minutes last week must not silently lengthen an
 * appointment made before it did.
 *
 * Availability is rechecked the same way createBooking does, with this booking
 * excluded from the busy filter, and the exclusion constraint is still the
 * arbiter: two front-desk users moving different bookings into the same slot
 * both pass the recheck, and exactly one write survives.
 */
export async function rescheduleBooking(
  bookingId: string,
  organizationId: string,
  next: { startsAt: SlotTime; staffUserId?: string | null },
): Promise<void> {
  const { rows } = await db.execute(sql`
    select team_id, service_id, staff_user_id, status
      from bookings where id = ${bookingId} and organization_id = ${organizationId}`)
  const current = rows[0] as Record<string, unknown> | undefined
  // Scoped by organizationId in the statement, so a foreign id reads as
  // not-found rather than as a failed move.
  if (!current) throw new Error('NOT_FOUND')
  // A completed, cancelled or no-show booking is history. Moving one would
  // rewrite what happened rather than change what is going to.
  if (!['pending', 'confirmed'].includes(current.status as string)) {
    throw new Error('BAD_TRANSITION')
  }

  const staffUserId = next.staffUserId ?? (current.staff_user_id as string)
  const free = await listSlots({
    organizationId,
    teamId: current.team_id as string,
    serviceId: current.service_id as string,
    date: next.startsAt.slice(0, 10),
    staffUserId,
    excludeBookingId: bookingId,
  })
  if (!free.some((s) => s.startsAt === next.startsAt && s.staffUserId === staffUserId)) {
    throw new Error('SLOT_TAKEN')
  }

  try {
    await db.execute(sql`
      update bookings
         set starts_at = ${next.startsAt}::timestamp,
             ends_at = ${next.startsAt}::timestamp
                     + make_interval(mins => duration_minutes),
             staff_user_id = ${staffUserId},
             updated_at = now()
       where id = ${bookingId} and organization_id = ${organizationId}`)
  } catch (e) {
    // Same reporting as createBooking: a stale page and a lost race are
    // indistinguishable to whoever is moving it, and both mean pick another.
    if (isSlotTaken(e)) throw new Error('SLOT_TAKEN')
    throw e
  }
}
