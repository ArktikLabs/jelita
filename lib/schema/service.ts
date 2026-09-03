import {
  bigint, boolean, char, index, integer, pgTable, smallint, text, timestamp, unique,
} from 'drizzle-orm/pg-core'
import { organizations } from './auth'

export const salonProfiles = pgTable('salon_profiles', {
  organizationId: text('organization_id').primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  currency: char('currency', { length: 3 }).notNull().default('IDR'),
  // The booking grid. Editable at any time because a booking stores its own
  // start and end -- changing this changes which slots are OFFERED tomorrow,
  // it cannot invalidate what is already booked (spec 2.3). Constrained to
  // {15, 20, 30, 45, 60} in the migration: 7-minute grids are a bug, not a
  // business model, and the check is what makes generate_series safe.
  slotMinutes: smallint('slot_minutes').notNull().default(30),
  // White-label (PRD 7). The BYTES live in object storage under
  // salons/<organizationId>/logo -- this records only that a logo exists and
  // when it changed, which is what busts the cache on /api/salon/logo.
  logoKey: text('logo_key'),
  logoUpdatedAt: timestamp('logo_updated_at', { withTimezone: true }),
  brandColor: text('brand_color'),
  // The receipt counter. Bumped by `update ... returning` at completion, which
  // is one statement and therefore serialises per salon without an explicit
  // lock -- two sales cannot be handed the same number.
  nextInvoiceNo: integer('next_invoice_no').notNull().default(1),
  // Commission (PRD 5.3). Resolved salon -> service -> service_staff by the
  // commission_rule view, the same coalesce shape service_branch_pricing uses
  // for price. `percent` is BASIS POINTS so 12.5% is exact and there is one
  // rounding site, not one per read; `flat` is minor units.
  commissionKind: text('commission_kind'),
  commissionValue: integer('commission_value'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const serviceCategories = pgTable('service_categories', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique('service_categories_org_id').on(t.organizationId, t.id)])

export const services = pgTable('services', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  categoryId: text('category_id'),
  name: text('name').notNull(),
  durationMinutes: smallint('duration_minutes').notNull(),
  // minor units (lib/money.ts). bigint because a 0-exponent currency puts
  // the whole rupiah figure in this column.
  price: bigint('price', { mode: 'number' }).notNull(),
  active: boolean('active').notNull().default(true),
  /** Overrides the salon default for this service. */
  commissionKind: text('commission_kind'),
  commissionValue: integer('commission_value'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('services_org_id').on(t.organizationId, t.id),
  index('services_org_idx').on(t.organizationId),
])

export const serviceBranchOverrides = pgTable('service_branch_overrides', {
  serviceId: text('service_id').notNull(),
  teamId: text('team_id').notNull(),
  organizationId: text('organization_id').notNull(),
  // null means INHERITS the salon price -- not the same as an override that
  // happens to equal it today (spec 2.1).
  price: bigint('price', { mode: 'number' }),
  offered: boolean('offered').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const serviceStaff = pgTable('service_staff', {
  serviceId: text('service_id').notNull(),
  userId: text('user_id').notNull(),
  organizationId: text('organization_id').notNull(),
  /** Overrides both the service and the salon default, for this pair. */
  commissionKind: text('commission_kind'),
  commissionValue: integer('commission_value'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
