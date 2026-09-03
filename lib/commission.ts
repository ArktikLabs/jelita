import { sql } from 'drizzle-orm'

/**
 * What a line earned.
 *
 * Rounding is HALF-UP AND SYMMETRIC: a reversal's line is negative, and
 * Math.round(-0.5) is -0 in JavaScript because it rounds toward +Infinity. A
 * void that rounded differently from the sale would leave a stylist owed or
 * owing a rupiah per voided line, which nothing would ever explain.
 */
export const roundHalfUp = (n: number) => Math.sign(n) * Math.round(Math.abs(n))

/**
 * `percent` is basis points against the line's net; `flat` is per unit
 * performed, so two haircuts earn twice -- and takes the line's sign, so a
 * reversal gives it back.
 */
export function commissionFor(
  line: { unitPrice: number; quantity: number; discount: number },
  rule: { kind: string; value: number },
): number {
  const net = line.unitPrice * line.quantity - line.discount
  if (rule.kind === 'percent') return roundHalfUp((net * rule.value) / 10000)
  return Math.sign(net) * rule.value * line.quantity
}

/**
 * Write the commission rows for one transaction, from its own lines.
 *
 * Called while the transaction is still `open`, from both checkout and void:
 * a reversal's lines are negative, so its commissions come out negative for
 * free and sum(amount) per staff per month is simply what they earned.
 *
 * A line with no stylist earns nothing and gets no row -- absence, not a zero,
 * so a recap never shows a phantom earner. That falls out of the join below
 * (commission_rule is keyed by user, and NULL joins to nothing) rather than
 * from a separate guard: a redundant `staff_user_id is not null` here could
 * be deleted without failing anything, which is worse than no guard because
 * it reads as one.
 */
export async function writeCommissions(
  tx: { execute: (q: ReturnType<typeof sql>) => Promise<{ rows: unknown[] }> },
  organizationId: string,
  transactionId: string,
): Promise<void> {
  const { rows } = await tx.execute(sql`
    select l.id, l.unit_price, l.quantity, l.discount, l.staff_user_id,
           r.kind, r.value
      from transaction_lines l
      join commission_rule r
        on r.service_id = l.service_id
       and r.user_id = l.staff_user_id
       and r.organization_id = l.organization_id
     where l.transaction_id = ${transactionId}
       and r.kind is not null`)

  for (const raw of rows as Record<string, unknown>[]) {
    const amount = commissionFor({
      unitPrice: Number(raw.unit_price),
      quantity: Number(raw.quantity),
      discount: Number(raw.discount),
    }, { kind: raw.kind as string, value: Number(raw.value) })

    await tx.execute(sql`
      insert into commissions (id, organization_id, transaction_id, transaction_line_id,
                               staff_user_id, kind, value, amount)
      values (${crypto.randomUUID()}, ${organizationId}, ${transactionId},
              ${raw.id as string}, ${raw.staff_user_id as string},
              ${raw.kind as string}, ${Number(raw.value)}, ${amount})`)
  }
}

export type RecapRow = {
  staffUserId: string
  staffName: string
  services: number
  revenue: number
  commission: number
  currency: string
}

/**
 * PRD §5.3's monthly recap, payroll-ready.
 *
 * Sums signed amounts, so a voided sale simply is not in the total -- there is
 * no "exclude reversals" clause here, and there must not be one, because the
 * next query somebody writes would have to remember it too.
 *
 * `onlyUserId` narrows to one stylist, which is how a role holding
 * commission:['read:own'] gets "my earnings this month" out of the same query
 * rather than a second one that could disagree.
 */
export async function commissionRecap(
  organizationId: string, month: string, onlyUserId?: string | null,
): Promise<RecapRow[]> {
  const { db } = await import('./db')
  const { rows } = await db.execute(sql`
    select c.staff_user_id, u.name as staff_name,
           sum(l.quantity)::int as services,
           sum(l.unit_price * l.quantity - l.discount)::bigint as revenue,
           sum(c.amount)::bigint as commission,
           max(t.currency) as currency
      from commissions c
      join transaction_lines l on l.id = c.transaction_line_id
      join transactions t on t.id = c.transaction_id
      join users u on u.id = c.staff_user_id
     where c.organization_id = ${organizationId}
       and t.completed_at >= ${month}::date
       and t.completed_at < (${month}::date + interval '1 month')
       ${onlyUserId ? sql`and c.staff_user_id = ${onlyUserId}` : sql``}
     group by c.staff_user_id, u.name
     order by sum(c.amount) desc, u.name`)
  return (rows as Record<string, unknown>[]).map((r) => ({
    staffUserId: r.staff_user_id as string,
    staffName: r.staff_name as string,
    services: Number(r.services),
    revenue: Number(r.revenue),
    commission: Number(r.commission),
    currency: (r.currency as string) ?? 'IDR',
  }))
}
