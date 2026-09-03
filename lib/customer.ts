import { sql } from 'drizzle-orm'
import { db } from './db'
import { normalizePhone } from './phone'
import { roundHalfUp } from './commission'

export type CustomerRow = {
  id: string
  name: string
  phone: string | null
  notes: string | null
  active: boolean
}

const rowsToCustomers = (rows: Record<string, unknown>[]): CustomerRow[] =>
  rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    phone: (r.phone as string) ?? null,
    notes: (r.notes as string) ?? null,
    active: r.active as boolean,
  }))

/**
 * Customers of one salon. `search` matches the name or the NORMALISED number,
 * so typing 0812 finds a customer stored as +62812 -- matching the raw `phone`
 * would miss exactly the spellings normalisation exists to unify.
 */
export async function listCustomers(
  organizationId: string, opts: { search?: string } = {},
): Promise<CustomerRow[]> {
  const term = (opts.search ?? '').trim()
  // Escape LIKE metacharacters: a bare '%' would otherwise match every
  // customer in the salon rather than searching for the character.
  const like = `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
  const key = term ? normalizePhone(term) : null
  const { rows } = await db.execute(sql`
    select id, name, phone, notes, active from customers
     where organization_id = ${organizationId}
       ${term === '' ? sql`` : sql`and (
         name ilike ${like}
         or (${key}::text is not null and phone_key like ${(key ?? '') + '%'})
       )`}
     order by name, id`)
  return rowsToCustomers(rows as Record<string, unknown>[])
}

/** Scoped by organizationId in the query, so a bare id cannot cross tenants. */
export async function getCustomer(customerId: string, organizationId: string) {
  const { rows } = await db.execute(sql`
    select id, name, phone, notes, active from customers
     where id = ${customerId} and organization_id = ${organizationId}`)
  return rowsToCustomers(rows as Record<string, unknown>[])[0] ?? null
}

/**
 * The lookup booking will call when a public booking names a number.
 *
 * Published now with no caller on purpose: booking must not invent its own
 * dedup rule. Two normalisation rules that disagree produce duplicate customers
 * that look identical to a human and split one person's history in half.
 *
 * The insert is `on conflict do nothing` against the partial unique index and
 * then re-reads, so two concurrent public bookings from the same number settle
 * on one customer instead of one of them erroring.
 */
export async function findOrCreateByPhone(
  organizationId: string, input: { name: string; phone: string },
): Promise<CustomerRow> {
  const key = normalizePhone(input.phone)
  if (!key) throw new Error('PHONE_REQUIRED')

  const existing = await db.execute(sql`
    select id, name, phone, notes, active from customers
     where organization_id = ${organizationId} and phone_key = ${key}`)
  const found = rowsToCustomers(existing.rows as Record<string, unknown>[])[0]
  if (found) return found

  await db.execute(sql`
    insert into customers (id, organization_id, name, phone, phone_key)
    values (${crypto.randomUUID()}, ${organizationId}, ${input.name},
            ${input.phone}, ${key})
    on conflict (organization_id, phone_key) where phone_key is not null
    do nothing`)

  const after = await db.execute(sql`
    select id, name, phone, notes, active from customers
     where organization_id = ${organizationId} and phone_key = ${key}`)
  const row = rowsToCustomers(after.rows as Record<string, unknown>[])[0]
  if (!row) throw new Error('CUSTOMER_CREATE_FAILED')
  return row
}

export type CustomerVisit = {
  id: string
  invoiceNo: number | null
  at: string
  total: number
  currency: string
  items: string
  reversal: boolean
}

export type CustomerBooking = {
  id: string
  startsAt: string
  serviceName: string
  staffName: string
  status: string
}

/**
 * PRD §5.7's profile: visit history and total spend.
 *
 * `spend` sums SIGNED totals over every non-open transaction, so a voided sale
 * corrects itself -- the same ledger property revenue and commission have, and
 * the reason there is no "exclude reversals" clause here for the next person to
 * forget.
 */
export async function customerProfile(customerId: string, organizationId: string) {
  const { rows: summary } = await db.execute(sql`
    select coalesce(sum(t.total), 0)::bigint as spend,
           count(*) filter (where t.reverses_id is null)::int as visits,
           to_char(max(t.completed_at), 'YYYY-MM-DD') as last_visit,
           max(t.currency) as currency
      from transactions t
     where t.organization_id = ${organizationId} and t.customer_id = ${customerId}
       and t.status <> 'open'`)
  const s = summary[0] as Record<string, unknown>

  const { rows: visitRows } = await db.execute(sql`
    select t.id, t.invoice_no, t.total, t.currency, t.reverses_id,
           to_char(t.completed_at, 'YYYY-MM-DD HH24:MI') as at,
           string_agg(l.name, ', ' order by l.id) as items
      from transactions t
      left join transaction_lines l on l.transaction_id = t.id
     where t.organization_id = ${organizationId} and t.customer_id = ${customerId}
       and t.status <> 'open'
     group by t.id
     order by t.completed_at desc
     limit 20`)

  const { rows: bookingRows } = await db.execute(sql`
    select b.id, b.status, s.name as service_name, u.name as staff_name,
           to_char(b.starts_at, 'YYYY-MM-DD"T"HH24:MI') as starts_at
      from bookings b
      join services s on s.id = b.service_id
      join users u on u.id = b.staff_user_id
     where b.organization_id = ${organizationId} and b.customer_id = ${customerId}
       and b.starts_at >= current_date
     order by b.starts_at
     limit 10`)

  const points = await pointsBalance(customerId, organizationId)
  const { rows: rate } = await db.execute(sql`
    select points_per_unit from salon_profiles where organization_id = ${organizationId}`)

  return {
    // Null when the salon runs no loyalty scheme, so the profile can leave
    // points out entirely rather than showing a zero balance.
    points: (rate[0] as { points_per_unit: number | null })?.points_per_unit === null
      ? null
      : points,
    spend: Number(s.spend),
    // Reversals are excluded from the COUNT but not from the sum: a voided
    // sale was not a visit, yet its money must still come back off the total.
    visits: Number(s.visits),
    lastVisit: (s.last_visit as string) ?? null,
    currency: (s.currency as string) ?? 'IDR',
    visitHistory: (visitRows as Record<string, unknown>[]).map((r) => ({
      id: r.id as string,
      invoiceNo: r.invoice_no === null ? null : Number(r.invoice_no),
      at: r.at as string,
      total: Number(r.total),
      currency: r.currency as string,
      items: (r.items as string) ?? '—',
      reversal: r.reverses_id !== null,
    })) satisfies CustomerVisit[],
    upcoming: (bookingRows as Record<string, unknown>[]).map((r) => ({
      id: r.id as string,
      startsAt: r.starts_at as string,
      serviceName: r.service_name as string,
      staffName: r.staff_name as string,
      status: r.status as string,
    })) satisfies CustomerBooking[],
  }
}

/**
 * Points for one sale's total (PRD §5.7).
 *
 * FLOORED, because part of a point is not a point -- and SYMMETRIC around
 * zero, which is the bit that bites: a reversal's total is negative, and
 * `Math.floor(-15.5)` is -16 while the sale earned 15, so a void would take
 * back one more point than it gave. Sign out, magnitude floored, sign back.
 *
 * The same trap commissionFor's rounding hit, which is why the sign handling
 * lives beside it rather than being re-derived here.
 */
export function pointsFor(total: number, perUnit: number | null): number {
  if (!perUnit || perUnit <= 0) return 0
  return Math.sign(total) * Math.floor(Math.abs(total) / perUnit)
}

/**
 * Write the points row for one transaction, inside the sale's own database
 * transaction.
 *
 * A sale with no customer earns NOTHING -- no row, not a zero row. §5.7 keys
 * members by WhatsApp number, and a walk-in who gave no number is not a member
 * yet. That is the cost of making the customer optional at the POS.
 */
export async function writePoints(
  tx: { execute: (q: ReturnType<typeof sql>) => Promise<{ rows: unknown[] }> },
  organizationId: string,
  transactionId: string,
): Promise<void> {
  // The SIGN comes from `reverses_id`, not from `total`. A reversal is built
  // with POSITIVE amounts and negated by the statement that settles it -- so
  // reading total here, before that statement runs, would have a void ADDING
  // points instead of giving them back. Same reason moveStockForSale reads the
  // direction the same way.
  const { rows } = await tx.execute(sql`
    select t.customer_id, p.points_per_unit,
           case when t.reverses_id is null then t.total else -t.total end as total
      from transactions t
      join salon_profiles p on p.organization_id = t.organization_id
     where t.id = ${transactionId} and t.customer_id is not null`)
  const r = rows[0] as Record<string, unknown> | undefined
  if (!r) return

  const points = pointsFor(Number(r.total), r.points_per_unit as number | null)
  // A zero-point row records nothing, and the check constraint refuses it.
  if (points === 0) return

  await tx.execute(sql`
    insert into customer_points (id, organization_id, customer_id, transaction_id, points)
    values (${crypto.randomUUID()}, ${organizationId}, ${r.customer_id as string},
            ${transactionId}, ${points})`)
}

/** The balance, summed from the ledger. */
export async function pointsBalance(
  customerId: string, organizationId: string,
): Promise<number> {
  const { rows } = await db.execute(sql`
    select coalesce(sum(points), 0)::bigint as balance from customer_points
     where organization_id = ${organizationId} and customer_id = ${customerId}`)
  return Number((rows[0] as { balance: string }).balance)
}
