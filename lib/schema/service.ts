import {
  bigint, boolean, char, index, pgTable, smallint, text, timestamp, unique,
} from 'drizzle-orm/pg-core'
import { organizations, teams } from './auth'

export const salonProfiles = pgTable('salon_profiles', {
  organizationId: text('organization_id').primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  currency: char('currency', { length: 3 }).notNull().default('IDR'),
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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
