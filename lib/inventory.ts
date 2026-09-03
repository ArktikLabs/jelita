import { sql } from 'drizzle-orm'
import { db } from './db'
import { pgCode } from './pg-error'

/**
 * Stock, as a ledger.
 *
 * On-hand is always read through the `stock_on_hand` view, never summed here:
 * the products list, the POS and the check suite must agree on one number, and
 * three places each summing it their own way is three chances to disagree.
 */

export type ProductRow = {
  id: string
  name: string
  sku: string | null
  kind: string
  price: number | null
  reorderLevel: number
  active: boolean
  onHand: number
  low: boolean
}

/** Products with this branch's on-hand. */
export async function listProducts(
  organizationId: string, teamId: string,
): Promise<ProductRow[]> {
  const { rows } = await db.execute(sql`
    select p.id, p.name, p.sku, p.kind, p.price, p.reorder_level, p.active,
           h.on_hand, h.low
      from products p
      join stock_on_hand h
        on h.product_id = p.id and h.team_id = ${teamId}
     where p.organization_id = ${organizationId}
     order by p.name, p.id`)
  return (rows as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    sku: (r.sku as string) ?? null,
    kind: r.kind as string,
    price: r.price === null ? null : Number(r.price),
    reorderLevel: Number(r.reorder_level),
    active: r.active as boolean,
    onHand: Number(r.on_hand),
    low: r.low as boolean,
  }))
}

/** What a POS cart may sell: active retail products, with their price. */
export async function sellableProducts(organizationId: string, teamId: string) {
  return (await listProducts(organizationId, teamId))
    .filter((p) => p.active && p.kind === 'retail')
}

/** Every product at or below its reorder level, across the branch. PRD §5.4's
 *  low-stock alert. */
export async function lowStock(organizationId: string, teamId: string) {
  return (await listProducts(organizationId, teamId)).filter((p) => p.active && p.low)
}

/**
 * One ledger entry. Never an update -- a correction is another movement
 * (spec 2.2), and the trigger refuses anything else anyway.
 */
export async function recordMovement(input: {
  organizationId: string
  teamId: string
  productId: string
  quantity: number
  reason: 'purchase' | 'sale' | 'usage' | 'adjustment'
  actorUserId?: string | null
  transactionId?: string | null
  note?: string | null
}): Promise<void> {
  if (!Number.isInteger(input.quantity) || input.quantity === 0) {
    throw new Error('BAD_QUANTITY')
  }
  try {
    await db.execute(sql`
      insert into stock_movements (id, organization_id, team_id, product_id, quantity,
                                   reason, actor_user_id, transaction_id, note)
      values (${crypto.randomUUID()}, ${input.organizationId}, ${input.teamId},
              ${input.productId}, ${input.quantity}, ${input.reason},
              ${input.actorUserId ?? null}, ${input.transactionId ?? null},
              ${input.note ?? null})`)
  } catch (e) {
    // A foreign key here means the product or the branch is not this salon's.
    // Translated at the boundary, because drizzle wraps the driver error and a
    // caller matching on `.message` would see only "Failed query: ...".
    if (pgCode(e) === '23503') throw new Error('NOT_FOUND')
    throw e
  }
}

/**
 * Stock movements for one transaction's product lines, written inside the
 * sale's own database transaction.
 *
 * The SIGN comes from whether the transaction is a REVERSAL, not from its
 * amounts. Amounts were the obvious choice -- voidSale mirrors a line by
 * negating them -- but a line discounted to zero nets zero, and a sign of zero
 * is a movement of zero, which the check constraint refuses. The goods still
 * left the shelf. `reverses_id` says which direction stock moves without
 * depending on what anything cost.
 */
export async function moveStockForSale(
  tx: { execute: (q: ReturnType<typeof sql>) => Promise<{ rows: unknown[] }> },
  organizationId: string,
  teamId: string,
  transactionId: string,
  actorUserId: string,
): Promise<void> {
  await tx.execute(sql`
    insert into stock_movements (id, organization_id, team_id, product_id, quantity,
                                 reason, actor_user_id, transaction_id)
    select gen_random_uuid()::text, ${organizationId}, ${teamId}, l.product_id,
           case when t.reverses_id is null then -l.quantity else l.quantity end,
           'sale', ${actorUserId}, ${transactionId}
      from transaction_lines l
      join transactions t on t.id = l.transaction_id
     where l.transaction_id = ${transactionId}
       and l.kind = 'product'`)
}
