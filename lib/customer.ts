import { sql } from 'drizzle-orm'
import { db } from './db'
import { normalizePhone } from './phone'
import { roundHalfUp } from './commission'
import { parseMoney, type CurrencyCode } from './money'

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
    select points_kind from salon_profiles where organization_id = ${organizationId}`)

  return {
    // Null when the salon runs no loyalty scheme, so the profile can leave
    // points out entirely rather than showing a zero balance.
    points: (rate[0] as { points_kind: string | null })?.points_kind === null
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

export type PointsRule = { kind: string | null; value: number | null }

/**
 * The stored value for a points rule, from what an owner typed.
 *
 * A `spend` value is MONEY and goes through parseMoney; a `visit` value is a
 * COUNT of points and must not. Running the count through parseMoney would
 * multiply it by the currency's exponent -- "5 points per visit" becoming 500
 * in SGD -- which is invisible in IDR, where the exponent is zero. That is
 * exactly why this is a function with its own test rather than two lines
 * inside a Server Action.
 */
export function parsePointsValue(
  kind: string, raw: string, currency: CurrencyCode,
): number | null {
  if (kind === 'spend') return parseMoney(raw, currency)
  if (kind === 'visit') return /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : null
  return null
}

/**
 * Points for one sale (PRD §5.7).
 *
 *   'spend' -- floored, because part of a point is not a point
 *   'visit' -- a flat award, whatever the sale cost
 *
 * `direction` is +1 for a sale and -1 for a reversal, passed in rather than
 * read off the total. Two reasons, and the second only shows up for `visit`:
 *
 *   A reversal's total is negative, and `Math.floor(-15.5)` is -16 while the
 *   sale earned 15 -- so deriving the sign from the total takes back one point
 *   too many. Same trap commissionFor's rounding hit.
 *
 *   A sale discounted to nothing still HAPPENED. `Math.sign(0)` is 0, so a
 *   free visit would earn no visit bonus and its void would give none back.
 */
export function pointsFor(
  total: number, rule: PointsRule, direction: 1 | -1 = 1,
): number {
  if (!rule.kind || !rule.value || rule.value <= 0) return 0
  if (rule.kind === 'visit') return direction * rule.value
  return direction * Math.floor(Math.abs(total) / rule.value)
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
  // DIRECTION comes from `reverses_id`, never from the total's sign. A reversal
  // is built with POSITIVE amounts and negated by the statement that settles
  // it, so reading the total here -- before that statement runs -- would have a
  // void ADDING points. Same reason moveStockForSale reads its direction this
  // way, and it also keeps a free visit's bonus working (see pointsFor).
  const { rows } = await tx.execute(sql`
    select t.customer_id, t.total, p.points_kind, p.points_value,
           (t.reverses_id is null) as forward
      from transactions t
      join salon_profiles p on p.organization_id = t.organization_id
     where t.id = ${transactionId} and t.customer_id is not null`)
  const r = rows[0] as Record<string, unknown> | undefined
  if (!r) return

  const points = pointsFor(
    Number(r.total),
    { kind: r.points_kind as string | null, value: r.points_value as number | null },
    r.forward ? 1 : -1,
  )
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
