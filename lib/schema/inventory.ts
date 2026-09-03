import {
  bigint, boolean, index, integer, pgTable, text, timestamp, unique,
} from 'drizzle-orm/pg-core'
import { organizations } from './auth'

/**
 * Something on a shelf. `retail` is sold at the POS and deducted
 * automatically; `internal` is consumed by treatments and moves through
 * `usage` movements (PRD §5.4).
 *
 * One price per product, salon-wide: a treatment's price varies by location,
 * which is why services have branch overrides -- a bottle of shampoo does not.
 */
export const products = pgTable('products', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  sku: text('sku'),
  kind: text('kind').notNull().default('retail'),
  // Minor units (lib/money.ts). Null for internal stock, which is never sold.
  price: bigint('price', { mode: 'number' }),
  // The low-stock threshold. On-hand at or below it is flagged.
  reorderLevel: integer('reorder_level').notNull().default(0),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('products_org_id').on(t.organizationId, t.id),
  unique('products_org_sku').on(t.organizationId, t.sku),
  index('products_org_name_idx').on(t.organizationId, t.name),
])

/**
 * The stock ledger. On-hand is the SUM of these, never a cached counter: a
 * counter beside the ledger is a second source of truth that drifts the first
 * time anything fails halfway (spec 2.1).
 *
 * Append-only, enforced by a trigger. A correction is another movement -- that
 * is what a ledger is (spec 2.2).
 */
export const stockMovements = pgTable('stock_movements', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  // Stock is per branch (PRD §5.8).
  teamId: text('team_id').notNull(),
  productId: text('product_id').notNull(),
  // Signed: positive in, negative out. Never zero.
  quantity: integer('quantity').notNull(),
  reason: text('reason').notNull(),
  actorUserId: text('actor_user_id'),
  // Set on `sale` movements, so a deduction is traceable to the sale that
  // caused it -- and a void's return to the void.
  transactionId: text('transaction_id'),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('stock_movements_balance_idx').on(t.organizationId, t.productId, t.teamId),
])
