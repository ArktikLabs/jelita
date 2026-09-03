import { sql } from 'drizzle-orm'
import { db } from './db'
import { ManualPayment, type PaymentMethod } from './payment'
import { pgMentions } from './pg-error'
import { writeCommissions } from './commission'
import { moveStockForSale } from './inventory'
import { writePoints } from './customer'

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
  /** Exactly one of these. `kind` on the line is derived from which. */
  serviceId?: string | null
  productId?: string | null
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
 * CLOSING is opt-in per salon (`auto_close_shift`, off by default). With it on,
 * the first sale of a new day closes yesterday's session -- which is what makes
 * "void until the shift ends" true without depending on anyone remembering.
 * Left off, a shift nobody closes stays open and yesterday's sales stay
 * voidable, which is the salon's choice to make rather than ours.
 *
 * The automatic close records NO closer. Attributing it to whoever happened to
 * ring up the first sale of the next day would put a name on a decision they
 * did not make.
 *
 * `on conflict do nothing` against the one-open-shift-per-branch index, then
 * re-read: two concurrent first-sales settle on one shift rather than one of
 * them erroring, the same shape findOrCreateByPhone uses.
 */
export async function currentShift(
  organizationId: string, teamId: string, userId: string,
): Promise<string> {
  // Day boundaries are the server's, matching every other wall-clock time in
  // the product (booking spec 2.6): the salon and its customers are in one
  // timezone.
  const stale = await db.execute(sql`
    update shifts s set closed_at = now()
      from salon_profiles p
     where s.team_id = ${teamId} and s.closed_at is null
       and p.organization_id = s.organization_id
       and p.auto_close_shift
       and s.opened_at::date < current_date
    returning s.id`)
  void stale

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
  /**
   * When the sale completed. Defaults to now.
   *
   * Exists because a completed transaction is immutable (spec 2.1) -- there is
   * no second chance to set this, so backdated entry has to say so up front.
   * Used by the demo seed, and by a salon catching up on paper records.
   */
  completedAt?: string | null
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

    // Prices come from the database inside this transaction, never from the
    // caller: a branch override applies and a posted price cannot.
    const serviceIds = input.items.map((i) => i.serviceId).filter(Boolean) as string[]
    const productIds = input.items.map((i) => i.productId).filter(Boolean) as string[]
    if (serviceIds.length + productIds.length !== input.items.length) {
      // Exactly one subject per line -- also a check constraint, but caught
      // here so it reads as a refusal rather than a constraint error.
      throw new Error('BAD_LINE')
    }

    const prices = new Map<string, { name: string; price: number }>()
    let currency: string | null = null

    if (serviceIds.length > 0) {
      const priced = await tx.execute(sql`
        select p.service_id as id, s.name, p.price, p.currency
          from service_branch_pricing p
          join services s on s.id = p.service_id
         where p.organization_id = ${input.organizationId}
           and p.team_id = ${input.teamId}
           and p.offered
           and p.service_id in ${sql`(${sql.join(
             serviceIds.map((id) => sql`${id}`), sql`, `)})`}`)
      for (const r of priced.rows as Record<string, unknown>[]) {
        prices.set(r.id as string, { name: r.name as string, price: Number(r.price) })
        currency = r.currency as string
      }
      if (prices.size !== new Set(serviceIds).size) throw new Error('NOT_OFFERED')
    }

    if (productIds.length > 0) {
      // Only ACTIVE RETAIL products. An internal-use item has no price and is
      // never sold; an inactive one has been withdrawn.
      const priced = await tx.execute(sql`
        select pr.id, pr.name, pr.price, sp.currency
          from products pr
          join salon_profiles sp on sp.organization_id = pr.organization_id
         where pr.organization_id = ${input.organizationId}
           and pr.active and pr.kind = 'retail'
           and pr.id in ${sql`(${sql.join(
             productIds.map((id) => sql`${id}`), sql`, `)})`}`)
      const before = prices.size
      for (const r of priced.rows as Record<string, unknown>[]) {
        prices.set(r.id as string, { name: r.name as string, price: Number(r.price) })
        currency = r.currency as string
      }
      if (prices.size - before !== new Set(productIds).size) throw new Error('NOT_OFFERED')
    }
    if (!currency) throw new Error('NOT_OFFERED')
    let subtotal = 0
    let lineDiscounts = 0
    for (const item of input.items) {
      if (item.quantity < 1) throw new Error('BAD_QUANTITY')
      const p = prices.get((item.serviceId ?? item.productId)!)!
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
      const p = prices.get((item.serviceId ?? item.productId)!)!
      await tx.execute(sql`
        insert into transaction_lines (id, transaction_id, organization_id, kind,
                                       service_id, product_id, staff_user_id, name,
                                       unit_price, quantity, discount)
        values (${crypto.randomUUID()}, ${id}, ${input.organizationId},
                ${item.serviceId ? 'service' : 'product'},
                ${item.serviceId ?? null}, ${item.productId ?? null},
                ${item.staffUserId ?? null}, ${p.name}, ${p.price}, ${item.quantity},
                ${item.discount})`)
    }

    // Written while the transaction is still `open`, so the immutability
    // trigger permits it and a voided sale's commissions can be written the
    // same way.
    await writeCommissions(tx, input.organizationId, id)
    // Retail lines leave the shelf. Inside the same transaction, so a failure
    // anywhere leaves neither the sale nor the deduction behind.
    await moveStockForSale(tx, input.organizationId, input.teamId, id, input.userId)
    // Points, from the total this transaction just wrote (PRD 5.7).
    await writePoints(tx, input.organizationId, id)

    const result = await ManualPayment.record({ method: input.method, amount: total, currency })
    await tx.execute(sql`
      insert into transaction_payments (id, transaction_id, organization_id, method,
                                        amount, provider, provider_ref, status)
      values (${crypto.randomUUID()}, ${id}, ${input.organizationId}, ${input.method},
              ${total}, ${result.provider}, ${result.ref ?? null}, ${result.status})`)

    await tx.execute(sql`
      update transactions
         set status = 'completed',
             completed_at = coalesce(${input.completedAt ?? null}::timestamptz, now()),
             updated_at = now()
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
  transactionId: string, organizationId: string, actorUserId = 'system',
): Promise<{ id: string; invoiceNo: number }> {
  try {
    return await reverse(transactionId, organizationId, actorUserId)
  } catch (e) {
    // The trigger's own words, turned into something an action can act on.
    if (pgMentions(e, 'shift that closed')) throw new Error('SHIFT_CLOSED')
    throw e
  }
}

async function reverse(
  transactionId: string, organizationId: string, actorUserId: string,
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
      insert into transaction_lines (id, transaction_id, organization_id, kind,
                                     service_id, product_id, staff_user_id, name,
                                     unit_price, quantity, discount)
      select gen_random_uuid()::text, ${id}, l.organization_id, l.kind,
             l.service_id, l.product_id, l.staff_user_id, l.name,
             -l.unit_price, l.quantity, -l.discount
        from transaction_lines l where l.transaction_id = ${transactionId}`)

    // From the mirrored (negative) lines, so the earnings come back off the
    // month without anything having to know it is a void.
    await writeCommissions(tx, organizationId, id)
    // And the goods go back on the shelf. moveStockForSale reads the
    // direction from `reverses_id`, which is already set above.
    const { rows: teamRows } = await tx.execute(sql`
      select team_id from transactions where id = ${id}`)
    await moveStockForSale(
      tx, organizationId, (teamRows[0] as { team_id: string }).team_id, id, actorUserId)
    // And the points come back off, from the reversal's negative total.
    await writePoints(tx, organizationId, id)

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
  const earned = await db.execute(sql`
    select points from customer_points where transaction_id = ${transactionId}`)

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
    // Null when this sale earned none -- no customer, or no loyalty scheme.
    points: earned.rows[0]
      ? Number((earned.rows[0] as { points: number }).points)
      : null,
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
