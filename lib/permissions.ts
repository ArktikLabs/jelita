import { createAccessControl } from 'better-auth/plugins/access'
import {
  defaultStatements,
  adminAc,
  ownerAc,
} from 'better-auth/plugins/organization/access'

/**
 * Salon access control (PRD §3 personas → roles).
 *
 * Resources are the things a salon actually guards. `member`/`invitation`/
 * `team`/`organization`/`ac` come from better-auth and cover tenancy itself.
 */
export const statement = {
  ...defaultStatements,
  booking: ['create', 'read', 'update', 'cancel', 'reschedule'],
  pos: ['checkout', 'discount', 'void'],
  service: ['create', 'read', 'update', 'delete'],
  product: ['create', 'read', 'update', 'delete'],
  stock: ['read', 'adjust'],
  customer: ['create', 'read', 'update'],
  commission: ['read', 'read:own'],
  payroll: ['read', 'run', 'lock'],
  report: ['read', 'export'],
  staff: ['create', 'read', 'update', 'deactivate'],
  branch: ['create', 'read', 'update', 'switch'],
  notification: ['read', 'send', 'template:update'],
  settings: ['read', 'update'],
} as const

export const ac = createAccessControl(statement)

// Everything a salon guards = the statement minus better-auth's own tenancy
// resources (those come from ownerAc/adminAc). Rest-destructure so adding a
// resource above grants it to owner/admin automatically.
const {
  organization: _organization,
  member: _member,
  invitation: _invitation,
  team: _team,
  ac: _ac,
  ...everything
} = statement

/** Salon owner. Everything, including deleting the tenant. */
export const owner = ac.newRole({ ...ownerAc.statements, ...everything })

/** Manager. Everything operational; cannot delete the organization itself. */
export const admin = ac.newRole({ ...adminAc.statements, ...everything })

/**
 * Front desk / kasir. Runs the day: bookings, checkout, members.
 * Deliberately NOT granted: pos.void (§5.2 immutability), payroll, staff
 * management, settings, or any branch switching.
 */
export const frontdesk = ac.newRole({
  booking: ['create', 'read', 'update', 'cancel', 'reschedule'],
  pos: ['checkout', 'discount'],
  service: ['read'],
  product: ['read'],
  stock: ['read'],
  customer: ['create', 'read', 'update'],
  branch: ['read'],
  notification: ['read', 'send'],
})

/**
 * Therapist / stylist. Read-only view of own schedule and own earnings
 * (PRD §3: "read-only view for Staff", §5.3 "my earnings this month").
 */
export const stylist = ac.newRole({
  booking: ['read'],
  commission: ['read:own'],
  customer: ['read'],
  service: ['read'],
  branch: ['read'],
})

export const roles = { owner, admin, frontdesk, stylist }
export type SalonRole = keyof typeof roles
