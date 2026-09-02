import {
  bigint, char, index, pgTable, smallint, text, timestamp,
} from 'drizzle-orm/pg-core'
import { organizations } from './auth'

/**
 * An appointment. The double-booking guarantee is NOT here -- it is an
 * exclusion constraint over (staff_user_id, tsrange(starts_at, ends_at)),
 * partial on the holding statuses, added in the migration because Drizzle
 * cannot express it (spec 3.3).
 *
 * `starts_at`/`ends_at` are LOCAL timestamps, not timestamptz: the salon and
 * its customers are in one timezone and staff_working_hours already returns
 * bare `time`. A 14:00 appointment is 14:00 on the wall (spec 2.6).
 */
export const bookings = pgTable('bookings', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  // Snapshotted, not derived from staff_profiles.team_id: a stylist who
  // transfers branches must not rewrite where past appointments happened.
  teamId: text('team_id').notNull(),
  // Always a real person. "Any available" is a fan-out at slot time and an
  // assignment at booking time -- never a stored value (spec 2.4).
  staffUserId: text('staff_user_id').notNull(),
  customerId: text('customer_id').notNull(),
  serviceId: text('service_id').notNull(),
  startsAt: timestamp('starts_at', { withTimezone: false }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: false }).notNull(),
  // pending | confirmed | completed | cancelled | no_show. pending and
  // confirmed hold the slot; cancelling releases it (spec 2.2).
  status: text('status').notNull().default('pending'),
  // Terms as they were when the booking was made. A service's price and
  // duration change; last week's booking was made at last week's terms, and
  // storing ends_at means a service growing 60 -> 90 minutes cannot
  // retroactively overlap the appointment after it (spec 2.5).
  durationMinutes: smallint('duration_minutes').notNull(),
  price: bigint('price', { mode: 'number' }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // The day list's only query.
  index('bookings_day_idx').on(t.organizationId, t.teamId, t.startsAt),
])
