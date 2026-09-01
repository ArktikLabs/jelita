import { sql } from 'drizzle-orm'
import { db } from './db'
import { normalizePhone } from './phone'

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
  const key = term ? normalizePhone(term) : null
  const { rows } = await db.execute(sql`
    select id, name, phone, notes, active from customers
     where organization_id = ${organizationId}
       ${term === '' ? sql`` : sql`and (
         name ilike ${'%' + term + '%'}
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
