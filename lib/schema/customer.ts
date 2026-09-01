import { boolean, index, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core'
import { organizations } from './auth'

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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // So a future booking or transaction can carry a composite FK and make a
  // cross-tenant reference unrepresentable, as the services join tables do.
  unique('customers_org_id').on(t.organizationId, t.id),
  index('customers_org_name_idx').on(t.organizationId, t.name),
])
