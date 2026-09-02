import {
  boolean, date, pgTable, primaryKey, smallint, text, time, timestamp,
} from 'drizzle-orm/pg-core'
import { organizations } from './auth'

/** The normal week: one interval per weekday, mirroring branch_hours. */
export const staffHours = pgTable('staff_hours', {
  userId: text('user_id').notNull(),
  organizationId: text('organization_id').notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  weekday: smallint('weekday').notNull(),   // 0 = Sunday, matches extract(dow)
  closed: boolean('closed').notNull().default(false),
  opensAt: time('opens_at').notNull().default('09:00'),
  closesAt: time('closes_at').notNull().default('21:00'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.userId, t.organizationId, t.weekday] })])

/**
 * This whole date is different -- REPLACES the weekday pattern, so it both
 * removes a normal day and adds an unusual one. `closed` defaults true because
 * a day off is the common case.
 */
export const staffScheduleExceptions = pgTable('staff_schedule_exceptions', {
  userId: text('user_id').notNull(),
  organizationId: text('organization_id').notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  onDate: date('on_date').notNull(),
  closed: boolean('closed').notNull().default(true),
  opensAt: time('opens_at'),
  closesAt: time('closes_at'),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.userId, t.organizationId, t.onDate] })])

/**
 * A window on a date that is unavailable -- SUBTRACTS from the day. Several
 * per date allowed: two separate errands are two blocks, so deliberately not
 * unique per date.
 *
 * Not resolved by staff_working_hours: a block is a busy period, applied by
 * booking in the same filter as existing appointments. Folding it in would
 * force that function to return windows (spec 2.4).
 */
export const staffTimeOff = pgTable('staff_time_off', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  organizationId: text('organization_id').notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  onDate: date('on_date').notNull(),
  startsAt: time('starts_at').notNull(),
  endsAt: time('ends_at').notNull(),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
