import {
  index, pgTable, primaryKey, text, timestamp, unique,
} from 'drizzle-orm/pg-core'
import { organizations } from './auth'

/**
 * The message an event sends (PRD §5.5). Editable by admin; seeded per salon
 * by trigger, so a new salon has working messages on day one rather than
 * silently sending nothing -- the same reason staff_hours is seeded for a new
 * hire.
 */
export const notificationTemplates = pgTable('notification_templates', {
  organizationId: text('organization_id').notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  body: text('body').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.kind] })])

/**
 * The queue.
 *
 * `to` and `body` are SNAPSHOTS. §5.5 asks the Notification Center to show
 * "the exact message that would be sent", and that is only exact if it is the
 * text itself -- a template re-rendered at view time against data that has
 * since changed is a different message.
 *
 * Real states, not a fiction: a row is `queued` until its `send_at` passes and
 * something processes it. In this MVP that something is a button; in
 * production it is a cron hitting the same code path (spec §2.4).
 */
export const notifications = pgTable('notifications', {
  id: text('id').primaryKey(),
  // NULLABLE, both of them. A verification email at signup has neither: the
  // account exists, the salon does not. Where an organization CAN be resolved
  // -- a password reset for someone who already works at a salon -- it is set,
  // and the message appears in that salon's Center.
  organizationId: text('organization_id')
    .references(() => organizations.id, { onDelete: 'cascade' }),
  teamId: text('team_id'),
  bookingId: text('booking_id'),
  customerId: text('customer_id'),
  kind: text('kind').notNull(),
  channel: text('channel').notNull().default('whatsapp'),
  to: text('to').notNull(),
  body: text('body').notNull(),
  status: text('status').notNull().default('queued'),
  // WALL CLOCK, like the bookings.starts_at three of the four derive from.
  // A salon and its customers share one clock; comparing an appointment's
  // wall time against an instant is how a reminder fires an hour out.
  sendAt: timestamp('send_at', { withTimezone: false }).notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  provider: text('provider'),
  providerRef: text('provider_ref'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // One message per booking per event. Queuing twice is not a thing.
  unique('notifications_one_per_event').on(t.bookingId, t.kind),
  index('notifications_due_idx').on(t.organizationId, t.status, t.sendAt),
])
