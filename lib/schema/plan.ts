import {
  bigint, boolean, index, integer, pgTable, primaryKey, text, timestamp,
} from 'drizzle-orm/pg-core'
import { organizations } from './auth'

export const features = pgTable('features', {
  key: text('key').primaryKey(),
  label: text('label').notNull(),
  description: text('description'),
  sortOrder: integer('sort_order').notNull().default(0),
})

export const plans = pgTable('plans', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  priceIdr: bigint('price_idr', { mode: 'number' }).notNull().default(0),
  billingInterval: text('billing_interval').notNull().default('month'),
  isDefault: boolean('is_default').notNull().default(false),
  active: boolean('active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
})

export const planLimits = pgTable('plan_limits', {
  planId: bigint('plan_id', { mode: 'number' })
    .notNull().references(() => plans.id, { onDelete: 'cascade' }),
  resource: text('resource').notNull(),
  cap: integer('cap').notNull(),
}, (t) => [primaryKey({ columns: [t.planId, t.resource] })])

export const planFeatures = pgTable('plan_features', {
  planId: bigint('plan_id', { mode: 'number' })
    .notNull().references(() => plans.id, { onDelete: 'cascade' }),
  featureKey: text('feature_key')
    .notNull().references(() => features.key, { onDelete: 'restrict' }),
}, (t) => [
  primaryKey({ columns: [t.planId, t.featureKey] }),
  index('plan_features_feature_idx').on(t.featureKey),
])

export const subscriptions = pgTable('subscriptions', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  organizationId: text('organization_id').notNull().unique()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  planId: bigint('plan_id', { mode: 'number' })
    .notNull().references(() => plans.id),
  status: text('status').notNull().default('active'),
  currentPeriodStart: timestamp('current_period_start', { withTimezone: true })
    .notNull().defaultNow(),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  provider: text('provider').notNull().default('manual'),
  providerRef: text('provider_ref'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('subscriptions_plan_idx').on(t.planId)])
