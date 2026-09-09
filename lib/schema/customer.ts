import {
  bigint, boolean, index, pgTable, text, timestamp, unique,
} from 'drizzle-orm/pg-core'
import { organizations, users } from './auth'

export const customers = pgTable('customers', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  // As typed, so the front desk sees the number the customer gave.
  phone: text('phone'),
  // Normalised (lib/phone.ts). Derived on write, never displayed. The partial
  // unique index below lives on this, not on `phone`.
  phoneKey: text('phone_key'),
  notes: text('notes'),
  active: boolean('active').notNull().default(true),
  // NULLABLE and undefaulted: a public booking, the seed and the cron all
  // write without a signed-in user, and NULL means "not a person" rather
  // than "we forgot" (Task 2 threads the actor through the write paths).
  createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
  // WHEN a record stopped being offered, and by whom. Not "hide this row" --
  // `active` remains the single truth for that.
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: text('deleted_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // So a future booking or transaction can carry a composite FK and make a
  // cross-tenant reference unrepresentable, as the services join tables do.
  unique('customers_org_id').on(t.organizationId, t.id),
  index('customers_org_name_idx').on(t.organizationId, t.name),
])

/**
 * The points ledger (PRD §5.7).
 *
 * Rows, summed for a balance -- the third ledger in this product, for the
 * third time the same reason: a void writes the negation and the balance
 * corrects itself, with no report having to remember which rows to skip. A
 * cached balance on `customers` would be a second source of truth that drifts
 * the first time anything fails halfway.
 *
 * Redemption is post-MVP (§5.7 says so by name), so nothing spends these yet.
 */
export const customerPoints = pgTable('customer_points', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  customerId: text('customer_id').notNull(),
  transactionId: text('transaction_id').notNull(),
  // Signed: a reversal gives back what its sale earned.
  points: bigint('points', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // One sale earns one row -- a constraint, not a check somebody remembers.
  unique('customer_points_one_per_sale').on(t.transactionId),
  index('customer_points_balance_idx').on(t.organizationId, t.customerId),
])
