import {
  boolean, pgTable, primaryKey, smallint, text, time, timestamp,
} from 'drizzle-orm/pg-core'
import { teams, users } from './auth'

export const branchProfiles = pgTable('branch_profiles', {
  teamId: text('team_id').primaryKey()
    .references(() => teams.id, { onDelete: 'cascade' }),
  address: text('address'),
  phone: text('phone'),
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
})

export const branchHours = pgTable('branch_hours', {
  teamId: text('team_id').notNull()
    .references(() => teams.id, { onDelete: 'cascade' }),
  weekday: smallint('weekday').notNull(),   // 0 = Sunday, matches extract(dow)
  closed: boolean('closed').notNull().default(false),
  opensAt: time('opens_at').notNull().default('09:00'),
  closesAt: time('closes_at').notNull().default('21:00'),
}, (t) => [primaryKey({ columns: [t.teamId, t.weekday] })])
