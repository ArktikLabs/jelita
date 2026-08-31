import { boolean, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core'
import { organizations, teams, users } from './auth'

export const staffProfiles = pgTable('staff_profiles', {
  userId: text('user_id').notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  organizationId: text('organization_id').notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  // null for owner and admin: they are salon-wide, not assigned to a branch.
  teamId: text('team_id').references(() => teams.id, { onDelete: 'set null' }),
  active: boolean('active').notNull().default(true),
  deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique('staff_profiles_one_branch').on(t.userId, t.organizationId)])
