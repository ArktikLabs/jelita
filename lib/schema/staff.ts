import {
  bigint, boolean, date, index, pgTable, text, timestamp, unique,
} from 'drizzle-orm/pg-core'
import { organizations, teams, users } from './auth'

export const staffProfiles = pgTable('staff_profiles', {
  userId: text('user_id').notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  organizationId: text('organization_id').notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  // null for owner and admin: they are salon-wide, not assigned to a branch.
  teamId: text('team_id').references(() => teams.id, { onDelete: 'set null' }),
  active: boolean('active').notNull().default(true),
  // Monthly base, in minor units. NULLABLE on purpose: commission-only staff
  // are normal, and null ("not salaried") is a different statement from zero
  // ("salaried at nothing") -- an owner who sets one by accident should be
  // able to tell which they did (spec 2.1).
  baseSalary: bigint('base_salary', { mode: 'number' }),
  deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique('staff_profiles_one_branch').on(t.userId, t.organizationId)])

/**
 * PRD §5.9's deductions: a uniform, a product taken home, an advance against
 * next month.
 *
 * ROWS, not a column: several a month is the normal case, and one column per
 * staff per month would make the front desk add them up by hand -- the
 * spreadsheet this feature exists to replace. Each carries a note, so a
 * stylist asking "what is this Rp 50.000" has an answer.
 */
export const payrollDeductions = pgTable('payroll_deductions', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  // A date pinned to the first of the month, not a '2026-09' string: text
  // sorts correctly only by luck, cannot be range-compared, and puts the
  // parsing in every query that touches it.
  month: date('month').notNull(),
  // Positive, and the recap subtracts it. A signed column would let a
  // deduction quietly become a bonus, which is a different feature with a
  // different conversation behind it.
  amount: bigint('amount', { mode: 'number' }).notNull(),
  note: text('note'),
  actorUserId: text('actor_user_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('payroll_deductions_month_idx').on(t.organizationId, t.month)])

/**
 * A closed payroll month.
 *
 * The recap was computed on read, so a deduction edited after payday silently
 * rewrote a month somebody was already paid for. Closing snapshots the figures
 * and freezes the inputs; from then on the recap reads these rows.
 *
 * No reopening. A correction belongs in the NEXT month, where it is visible as
 * a correction, rather than silently altering a period that has been paid.
 */
export const payrollRuns = pgTable('payroll_runs', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  month: date('month').notNull(),
  closedBy: text('closed_by'),
  closedAt: timestamp('closed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // One run per month per salon: closing twice is not a thing, and a unique
  // constraint says so rather than a check somebody remembers.
  unique('payroll_runs_org_month').on(t.organizationId, t.month),
])

/** One staff member's figures AS THEY STOOD when the month closed. */
export const payrollRunLines = pgTable('payroll_run_lines', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  organizationId: text('organization_id').notNull(),
  userId: text('user_id').notNull(),
  // Null carries through: "not salaried" stays distinct from "salaried at
  // nothing" in the snapshot too.
  baseSalary: bigint('base_salary', { mode: 'number' }),
  commission: bigint('commission', { mode: 'number' }).notNull(),
  deductions: bigint('deductions', { mode: 'number' }).notNull(),
  net: bigint('net', { mode: 'number' }).notNull(),
}, (t) => [unique('payroll_run_lines_one_per_staff').on(t.runId, t.userId)])
