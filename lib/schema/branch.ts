import {
  boolean, pgTable, primaryKey, smallint, text, time, timestamp,
} from 'drizzle-orm/pg-core'
import { teams } from './auth'

export const branchProfiles = pgTable('branch_profiles', {
  teamId: text('team_id').primaryKey()
    .references(() => teams.id, { onDelete: 'cascade' }),
  address: text('address'),
  phone: text('phone'),
  active: boolean('active').notNull().default(true),
  deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
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
