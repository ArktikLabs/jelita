import {
  bigint, char, index, integer, pgTable, text, timestamp, unique,
} from 'drizzle-orm/pg-core'
import { organizations } from './auth'

/**
 * A sale. `open` is the cart; `completed` is money; `reversal` is a void.
 *
 * Immutability after completion is NOT expressed here -- Drizzle cannot, and a
 * convention would not hold anyway. A trigger refuses any update or delete on
 * a row past `open` (spec 2.1).
 *
 * Reversal amounts are stored NEGATIVE (spec 2.2) so that sum(total) over
 * every non-open row is revenue, with no report anywhere having to remember
 * which rows to subtract.
 */
export const transactions = pgTable('transactions', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  teamId: text('team_id').notNull(),
  // Nullable: a walk-in sale need not name anyone.
  customerId: text('customer_id'),
  // Nullable: a direct sale has no appointment behind it.
  bookingId: text('booking_id'),
  status: text('status').notNull().default('open'),
  // The transaction this one reverses. Unique, so a sale can be voided at
  // most once -- a constraint rather than a check somebody remembers.
  reversesId: text('reverses_id'),
  // All minor units (lib/money.ts). Discounts are AMOUNTS, never percentages
  // (spec 2.3): one rounding site instead of one per query.
  subtotal: bigint('subtotal', { mode: 'number' }).notNull().default(0),
  discount: bigint('discount', { mode: 'number' }).notNull().default(0),
  total: bigint('total', { mode: 'number' }).notNull().default(0),
  currency: char('currency', { length: 3 }).notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('transactions_org_id').on(t.organizationId, t.id),
  unique('transactions_reverses').on(t.reversesId),
  index('transactions_day_idx').on(t.organizationId, t.teamId, t.completedAt),
])

/**
 * One line. Name and unit price are SNAPSHOTS, exactly as bookings snapshot
 * duration and price: a receipt reprinted next month must say what was
 * charged, not what the price list says today.
 *
 * `kind` and `product_id` arrive with the products table (spec 3.2). A column
 * whose only value would be 'service' is scaffolding.
 */
export const transactionLines = pgTable('transaction_lines', {
  id: text('id').primaryKey(),
  transactionId: text('transaction_id').notNull(),
  organizationId: text('organization_id').notNull(),
  serviceId: text('service_id').notNull(),
  // Who performed it -- the hook commission records will hang off (spec 4.1).
  staffUserId: text('staff_user_id'),
  name: text('name').notNull(),
  unitPrice: bigint('unit_price', { mode: 'number' }).notNull(),
  quantity: integer('quantity').notNull().default(1),
  discount: bigint('discount', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('transaction_lines_txn_idx').on(t.transactionId)])

/**
 * One row per payment, so split payment is a UI change later rather than a
 * migration (PRD marks it P1).
 *
 * `provider` and `providerRef` are the PaymentProvider seam: ManualPayment
 * writes 'manual' and no reference, a gateway writes its own (spec 4.3).
 */
export const transactionPayments = pgTable('transaction_payments', {
  id: text('id').primaryKey(),
  transactionId: text('transaction_id').notNull(),
  organizationId: text('organization_id').notNull(),
  method: text('method').notNull(),
  amount: bigint('amount', { mode: 'number' }).notNull(),
  provider: text('provider').notNull().default('manual'),
  providerRef: text('provider_ref'),
  status: text('status').notNull().default('settled'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('transaction_payments_txn_idx').on(t.transactionId)])
