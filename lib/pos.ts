import { sql } from 'drizzle-orm'
import { db } from './db'
import { ManualPayment, type PaymentMethod } from './payment'
import { pgMentions } from './pg-error'

/**
 * The sale.
 *
 * THE CART IS NOT A ROW. It lives in the page, and `open` exists only inside
 * the write transaction below -- insert, add lines, take payment, complete,
 * commit. Nobody ever observes an open transaction.
 *
 * That is not tidiness. `transactions_one_per_booking` counts open rows, so a
 * durable cart abandoned against a booking would block that booking from ever
 * being charged, with the customer standing at the counter. A cart that only
 * exists inside one database transaction cannot be abandoned.
 *
 * PRICES ARE NEVER POSTED. The caller names services and quantities; this
 * module resolves the price from service_branch_pricing itself. A posted price
 * is a posted amount of money.
 */

export type CartItem = {
  serviceId: string
  quantity: number
  /** Minor units, never a percentage (spec 2.3). Zero unless the actor holds
   *  pos:['discount'] -- checked by the caller, which has the session. */
  discount: number
  /** Who performed it. The hook commission records will hang off. */
  staffUserId?: string | null
}

/**
 * The open shift for a branch, opening one if there is none.
 *
 * Auto-open on purpose: a till that refuses to sell because somebody forgot a
 * button is the worst failure a POS can have. Closing stays explicit, because
 * closing is the act that locks the takings.
 *
 * `on conflict do nothing` against the one-open-shift-per-branch index, then
 * re-read: two concurrent first-sales settle on one shift rather than one of
 * them erroring, the same shape findOrCreateByPhone uses.
 */
export async function currentShift(
  organizationId: string, teamId: string, userId: string,
): Promise<string> {
  const open = await db.execute(sql`
    select id from shifts where team_id = ${teamId} and closed_at is null`)
  if (open.rows[0]) return (open.rows[0] as { id: string }).id

  await db.execute(sql`
    insert into shifts (id, organization_id, team_id, opened_by)
    values (${crypto.randomUUID()}, ${organizationId}, ${teamId}, ${userId})
    on conflict do nothing`)

  const after = await db.execute(sql`
    select id from shifts where team_id = ${teamId} and closed_at is null`)
  const row = after.rows[0] as { id: string } | undefined
  if (!row) throw new Error('SHIFT_OPEN_FAILED')
  return row.id
}

export async function closeShift(
  shiftId: string, organizationId: string, userId: string,
): Promise<void> {
  const { rowCount } = await db.execute(sql`
    update shifts set closed_at = now(), closed_by = ${userId}
     where id = ${shiftId} and organization_id = ${organizationId}
       and closed_at is null`)
  // Scoped by organizationId, and gated on still being open in the same
  // statement -- two front-desk users closing at once cannot both succeed.
  if (!rowCount) throw new Error('SHIFT_NOT_OPEN')
}

/**
 * Ring up a sale. One database transaction: nothing half-written survives a
 * failure, and the `open` status is never visible outside it.
 */
export async function checkout(input: {
  organizationId: string
  teamId: string
  userId: string
  items: CartItem[]
  customerId?: string | null
  bookingId?: string | null
  method: PaymentMethod
  /** Order-level discount, minor units. */
  discount?: number
}): Promise<{ id: string; invoiceNo: number }> {
  if (input.items.length === 0) throw new Error('EMPTY_CART')
  const shiftId = await currentShift(input.organizationId, input.teamId, input.userId)

  // Constraint violations are translated at this boundary, not left raw:
  // drizzle wraps them, so a caller matching on `.message` sees only
  // "Failed query: ..." and every action would have to know that.
  try {
    return await ring(input, shiftId)
  } catch (e) {
    if (pgMentions(e, 'transactions_one_per_booking')) throw new Error('ALREADY_CHARGED')
    throw e
  }
}

async function ring(
  input: Parameters<typeof checkout>[0], shiftId: string,
): Promise<{ id: string; invoiceNo: number }> {
  return db.transaction(async (tx) => {
    const id = crypto.randomUUID()

    // Prices come from the view, inside this transaction, keyed by the branch
    // -- so a branch override applies and a posted price cannot.
    const priced = await tx.execute(sql`
      select p.service_id, s.name, p.price, p.currency
        from service_branch_pricing p
        join services s on s.id = p.service_id
       where p.organization_id = ${input.organizationId}
         and p.team_id = ${input.teamId}
         and p.offered
         and p.service_id in ${sql`(${sql.join(
           input.items.map((i) => sql`${i.serviceId}`), sql`, `)})`}`)
    const prices = new Map((priced.rows as Record<string, unknown>[]).map((r) => [
      r.service_id as string,
      { name: r.name as string, price: Number(r.price), currency: r.currency as string },
    ]))
    // Every line must price, or the sale is refused whole. A cart that
    // silently drops a service the branch stopped offering would charge less
    // than the receipt lists.
    if (prices.size !== new Set(input.items.map((i) => i.serviceId)).size) {
      throw new Error('NOT_OFFERED')
    }

    const currency = [...prices.values()][0].currency
    let subtotal = 0
    let lineDiscounts = 0
    for (const item of input.items) {
      if (item.quantity < 1) throw new Error('BAD_QUANTITY')
      const p = prices.get(item.serviceId)!
      const gross = p.price * item.quantity
      if (item.discount < 0 || item.discount > gross) throw new Error('BAD_DISCOUNT')
      subtotal += gross
      lineDiscounts += item.discount
    }
    const orderDiscount = input.discount ?? 0
    const discount = lineDiscounts + orderDiscount
    if (orderDiscount < 0 || discount > subtotal) throw new Error('BAD_DISCOUNT')
    const total = subtotal - discount

    // One statement, so it serialises per salon without an explicit lock: two
    // sales cannot be handed the same number.
    const numbered = await tx.execute(sql`
      update salon_profiles set next_invoice_no = next_invoice_no + 1
       where organization_id = ${input.organizationId}
      returning next_invoice_no - 1 as invoice_no`)
    const invoiceNo = Number((numbered.rows[0] as { invoice_no: number }).invoice_no)

    await tx.execute(sql`
      insert into transactions (id, organization_id, team_id, customer_id, booking_id,
                                shift_id, invoice_no, status, subtotal, discount,
                                total, currency)
      values (${id}, ${input.organizationId}, ${input.teamId}, ${input.customerId ?? null},
              ${input.bookingId ?? null}, ${shiftId}, ${invoiceNo}, 'open',
              ${subtotal}, ${discount}, ${total}, ${currency})`)

    for (const item of input.items) {
      const p = prices.get(item.serviceId)!
      await tx.execute(sql`
        insert into transaction_lines (id, transaction_id, organization_id, service_id,
                                       staff_user_id, name, unit_price, quantity, discount)
        values (${crypto.randomUUID()}, ${id}, ${input.organizationId}, ${item.serviceId},
                ${item.staffUserId ?? null}, ${p.name}, ${p.price}, ${item.quantity},
                ${item.discount})`)
    }

    const result = await ManualPayment.record({ method: input.method, amount: total, currency })
    await tx.execute(sql`
      insert into transaction_payments (id, transaction_id, organization_id, method,
                                        amount, provider, provider_ref, status)
      values (${crypto.randomUUID()}, ${id}, ${input.organizationId}, ${input.method},
              ${total}, ${result.provider}, ${result.ref ?? null}, ${result.status})`)

    await tx.execute(sql`
      update transactions set status = 'completed', completed_at = now(), updated_at = now()
       where id = ${id}`)

    // The money is better proof of attendance than a front-desk click, so this
    // completes a booking that is still `pending` -- a transition
    // setBookingStatus deliberately refuses (spec 2.5).
    if (input.bookingId) {
      await tx.execute(sql`
        update bookings set status = 'completed', updated_at = now()
         where id = ${input.bookingId} and organization_id = ${input.organizationId}
           and status in ('pending', 'confirmed')`)
    }

    // Seams, named rather than stubbed: stock deduction (PRD 5.4), commission
    // records (5.3), member points (5.7). Each needs a table that does not
    // exist yet; the line's staff_user_id is what commissions will read.

    return { id, invoiceNo }
  })
}

/**
 * Void a sale by writing its mirror, never by touching it.
 *
 * The shift window is enforced by a trigger, so this does not re-check it --
 * a check here would be a second opinion that can drift from the one that
 * actually decides.
 */
export async function voidSale(
  transactionId: string, organizationId: string,
): Promise<{ id: string; invoiceNo: number }> {
  try {
    return await reverse(transactionId, organizationId)
  } catch (e) {
    // The trigger's own words, turned into something an action can act on.
    if (pgMentions(e, 'shift that closed')) throw new Error('SHIFT_CLOSED')
    throw e
  }
}

async function reverse(
  transactionId: string, organizationId: string,
): Promise<{ id: string; invoiceNo: number }> {
  return db.transaction(async (tx) => {
    const found = await tx.execute(sql`
      select id, status from transactions
       where id = ${transactionId} and organization_id = ${organizationId}`)
    const row = found.rows[0] as { status: string } | undefined
    if (!row) throw new Error('NOT_FOUND')
    if (row.status !== 'completed') throw new Error('NOT_VOIDABLE')

    const numbered = await tx.execute(sql`
      update salon_profiles set next_invoice_no = next_invoice_no + 1
       where organization_id = ${organizationId}
      returning next_invoice_no - 1 as invoice_no`)
    const invoiceNo = Number((numbered.rows[0] as { invoice_no: number }).invoice_no)

    // The reversal is BUILT OPEN and settled at the end, exactly as a sale is.
    //
    // Not written straight to 'reversal': the line trigger refuses writes
    // whose parent is past `open`, so a reversal born settled could never be
    // given its own lines. Weakening that trigger to admit reversals would
    // open a door on every future path; giving the void the same lifecycle as
    // a sale keeps the rule absolute.
    //
    // Amounts start POSITIVE for the same reason -- transactions_total_sign
    // allows a negative total only on a reversal -- and are negated by the one
    // statement that settles it, which the trigger still permits because the
    // row is open until it runs.
    const id = crypto.randomUUID()
    await tx.execute(sql`
      insert into transactions (id, organization_id, team_id, customer_id, booking_id,
                                shift_id, invoice_no, status, reverses_id,
                                subtotal, discount, total, currency)
      select ${id}, t.organization_id, t.team_id, t.customer_id, t.booking_id,
             t.shift_id, ${invoiceNo}, 'open', t.id,
             t.subtotal, t.discount, t.total, t.currency
        from transactions t where t.id = ${transactionId}`)

    await tx.execute(sql`
      insert into transaction_lines (id, transaction_id, organization_id, service_id,
                                     staff_user_id, name, unit_price, quantity, discount)
      select gen_random_uuid()::text, ${id}, l.organization_id, l.service_id,
             l.staff_user_id, l.name, -l.unit_price, l.quantity, -l.discount
        from transaction_lines l where l.transaction_id = ${transactionId}`)

    await tx.execute(sql`
      update transactions
         set status = 'reversal', completed_at = now(), updated_at = now(),
             subtotal = -subtotal, discount = -discount, total = -total
       where id = ${id}`)

    return { id, invoiceNo }
  })
}

export type SaleRow = {
  id: string
  invoiceNo: number | null
  status: string
  total: number
  currency: string
  completedAt: string | null
  customerName: string | null
  reversesId: string | null
  /** Set when this sale has already been voided -- what hides the button. */
  reversedById: string | null
  shiftClosed: boolean
}

/** One branch's sales for a day, newest first. */
export async function listSales(
  organizationId: string, teamId: string, date: string,
): Promise<SaleRow[]> {
  const { rows } = await db.execute(sql`
    select t.id, t.invoice_no, t.status, t.total, t.currency, t.reverses_id,
           to_char(t.completed_at, 'YYYY-MM-DD"T"HH24:MI') as completed_at,
           c.name as customer_name,
           r.id as reversed_by_id,
           (s.closed_at is not null) as shift_closed
      from transactions t
      left join customers c on c.id = t.customer_id
      left join transactions r on r.reverses_id = t.id
      left join shifts s on s.id = t.shift_id
     where t.organization_id = ${organizationId} and t.team_id = ${teamId}
       and t.completed_at >= ${date}::date and t.completed_at < ${date}::date + 1
     order by t.completed_at desc, t.invoice_no desc`)
  return (rows as Record<string, unknown>[]).map(toSale)
}

const toSale = (r: Record<string, unknown>): SaleRow => ({
  id: r.id as string,
  invoiceNo: r.invoice_no === null ? null : Number(r.invoice_no),
  status: r.status as string,
  total: Number(r.total),
  currency: r.currency as string,
  completedAt: (r.completed_at as string) ?? null,
  customerName: (r.customer_name as string) ?? null,
  reversesId: (r.reverses_id as string) ?? null,
  reversedById: (r.reversed_by_id as string) ?? null,
  shiftClosed: r.shift_closed as boolean,
})

/** One sale with everything a receipt prints. Org-scoped in the query, so a
 *  bare id cannot cross tenants. */
export async function getSale(transactionId: string, organizationId: string) {
  const { rows } = await db.execute(sql`
    select t.id, t.invoice_no, t.status, t.total, t.subtotal, t.discount, t.currency,
           t.reverses_id,
           to_char(t.completed_at, 'YYYY-MM-DD"T"HH24:MI') as completed_at,
           c.name as customer_name, c.phone as customer_phone,
           r.id as reversed_by_id,
           (s.closed_at is not null) as shift_closed,
           tm.name as branch_name, bp.address as branch_address, bp.phone as branch_phone
      from transactions t
      left join customers c on c.id = t.customer_id
      left join transactions r on r.reverses_id = t.id
      left join shifts s on s.id = t.shift_id
      join teams tm on tm.id = t.team_id
      left join branch_profiles bp on bp.team_id = t.team_id
     where t.id = ${transactionId} and t.organization_id = ${organizationId}`)
  const r = rows[0] as Record<string, unknown> | undefined
  if (!r) return null

  const lines = await db.execute(sql`
    select name, unit_price, quantity, discount from transaction_lines
     where transaction_id = ${transactionId} order by id`)
  const payments = await db.execute(sql`
    select method, amount from transaction_payments
     where transaction_id = ${transactionId} order by id`)

  return {
    ...toSale(r),
    subtotal: Number(r.subtotal),
    discount: Number(r.discount),
    customerPhone: (r.customer_phone as string) ?? null,
    branchName: r.branch_name as string,
    branchAddress: (r.branch_address as string) ?? null,
    branchPhone: (r.branch_phone as string) ?? null,
    lines: (lines.rows as Record<string, unknown>[]).map((l) => ({
      name: l.name as string,
      unitPrice: Number(l.unit_price),
      quantity: Number(l.quantity),
      discount: Number(l.discount),
    })),
    payments: (payments.rows as Record<string, unknown>[]).map((p) => ({
      method: p.method as string,
      amount: Number(p.amount),
    })),
  }
}

/** The branch's open shift, if any -- what the close control needs. */
export async function openShift(organizationId: string, teamId: string) {
  const { rows } = await db.execute(sql`
    select s.id, to_char(s.opened_at, 'YYYY-MM-DD"T"HH24:MI') as opened_at,
           (select count(*)::int from transactions t
             where t.shift_id = s.id and t.status <> 'open') as sales,
           (select coalesce(sum(t.total), 0)::bigint from transactions t
             where t.shift_id = s.id and t.status <> 'open') as takings
      from shifts s
     where s.organization_id = ${organizationId} and s.team_id = ${teamId}
       and s.closed_at is null`)
  const r = rows[0] as Record<string, unknown> | undefined
  if (!r) return null
  return {
    id: r.id as string,
    openedAt: r.opened_at as string,
    sales: Number(r.sales),
    takings: Number(r.takings),
  }
}
