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
  // The till session this sale belongs to. Voiding is allowed while it is
  // open and refused after (spec 2.7).
  shiftId: text('shift_id'),
  // Per-salon running number, allocated atomically at completion. A UUID is
  // unusable over WhatsApp; this is what a customer quotes.
  invoiceNo: integer('invoice_no'),
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
  unique('transactions_invoice_no').on(t.organizationId, t.invoiceNo),
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
  // Exactly one of serviceId / productId is set, enforced by a check. `kind`
  // says which without a caller having to test for null.
  kind: text('kind').notNull().default('service'),
  serviceId: text('service_id'),
  productId: text('product_id'),
  // Who performed it. Drives the commission record; product lines carry none,
  // because §5.3's rules are keyed by service.
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

/**
 * A till session. The boundary a void lives inside: a sale can be reversed
 * while its shift is open, and not after (spec 2.7).
 *
 * Opened automatically by the first sale of a session -- a till that refuses
 * to sell because somebody forgot a button is the worst failure a POS can
 * have. Closing is explicit, because closing is the act that locks the
 * takings.
 *
 * No cash counting in the MVP: this is a boundary, not a drawer. An opening
 * float and a closing count are what it grows into.
 */
export const shifts = pgTable('shifts', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  teamId: text('team_id').notNull(),
  openedBy: text('opened_by').notNull(),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  closedBy: text('closed_by'),
  closedAt: timestamp('closed_at', { withTimezone: true }),
}, (t) => [
  unique('shifts_org_id').on(t.organizationId, t.id),
  index('shifts_open_idx').on(t.organizationId, t.teamId, t.closedAt),
])

/**
 * What one line earned, written at checkout and never derived on read.
 *
 * Two reasons, the second load-bearing: a stylist promoted to 20% must not
 * retroactively earn 20% on last month's work, and payroll pays on this
 * number -- one recomputed at every read can quietly differ from the one
 * somebody was paid.
 *
 * A reversal's lines are negative, so its commissions are too. That makes
 * sum(amount) per staff per month simply what they earned, with nothing
 * anywhere having to remember which rows to subtract.
 */
export const commissions = pgTable('commissions', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  transactionId: text('transaction_id').notNull(),
  transactionLineId: text('transaction_line_id').notNull(),
  staffUserId: text('staff_user_id').notNull(),
  // The rule as applied, so a recap can always explain itself.
  kind: text('kind').notNull(),
  value: integer('value').notNull(),
  amount: bigint('amount', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // One line earns one commission -- a constraint, not a check somebody
  // remembers to write.
  unique('commissions_one_per_line').on(t.transactionLineId),
  index('commissions_recap_idx').on(t.organizationId, t.staffUserId),
])
