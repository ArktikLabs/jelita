import { describe, expect, it } from 'vitest'
import { roles, type SalonRole } from '../lib/permissions'

/**
 * Facts about the role table itself. Pure: no database, no fixtures.
 *
 * These exist because several guards in the app choose one statement over
 * another for reasons no ROLE currently distinguishes -- so swapping them
 * fails no end-to-end test. Asserting the overlap is what makes the choice
 * falsifiable: the day a role holds one without the other, this fails and the
 * guard stops being interchangeable.
 */
const holds = (role: SalonRole, resource: string, action: string) => {
  const statements = roles[role].statements as Record<string, readonly string[]>
  return (statements[resource] ?? []).includes(action)
}

const ROLES = Object.keys(roles) as SalonRole[]

describe('the built-in roles', () => {
  it('gives payroll to owner and admin, and to nobody else', () => {
    for (const role of ROLES) {
      expect(holds(role, 'payroll', 'read'), role).toBe(role === 'owner' || role === 'admin')
    }
  })

  it('has no role holding report:read WITHOUT report:export', () => {
    // The CSV route is guarded by report:['export'] on the reading that
    // reading a figure on screen and carrying the whole table out of the
    // building are different acts. No built-in role separates them, so
    // swapping the guard for ['read'] fails nothing end to end -- verified by
    // trying it, as the plan predicted. This is what makes the choice
    // falsifiable: the day a role holds read alone, it fails.
    for (const role of ROLES) {
      if (holds(role, 'report', 'read')) {
        expect(holds(role, 'report', 'export'), `${role} would separate them`).toBe(true)
      }
    }
  })

  it('gives report to owner and admin, and to nobody else', () => {
    for (const role of ROLES) {
      expect(holds(role, 'report', 'read'), role).toBe(role === 'owner' || role === 'admin')
    }
  })

  it('has no role holding payroll:read WITHOUT payroll:lock', () => {
    // Closing a month is guarded by payroll:['lock'] on the reading that
    // reading a recap and ending a pay period are different acts. No built-in
    // role separates them, so swapping the guards fails nothing end to end --
    // this is what makes the choice falsifiable.
    for (const role of ROLES) {
      if (holds(role, 'payroll', 'read')) {
        expect(holds(role, 'payroll', 'lock'), `${role} would separate them`).toBe(true)
      }
    }
  })

  it('has no role holding staff:update WITHOUT payroll:read', () => {
    // Why this matters: the base-salary guard uses payroll:['read'] on the
    // deliberate reading that what someone is paid is a payroll fact, not a
    // staff-management one. No built-in role separates them, so swapping the
    // two fails nothing end to end -- verified by trying it.
    //
    // The day a salon-specific role holds staff:update alone (dynamicAccessControl
    // allows exactly that), this fails, and the guard starts to matter.
    for (const role of ROLES) {
      if (holds(role, 'staff', 'update')) {
        expect(holds(role, 'payroll', 'read'), `${role} would separate them`).toBe(true)
      }
    }
  })

  it('gives every stylist read:own but never read, for commission', () => {
    // The commissions page is guarded by the weaker statement so a stylist
    // reaches it, and shows everyone only to those holding the stronger one.
    expect(holds('stylist', 'commission', 'read:own')).toBe(true)
    expect(holds('stylist', 'commission', 'read')).toBe(false)
    expect(holds('owner', 'commission', 'read')).toBe(true)
  })

  it('keeps pos:void away from front desk while granting checkout and discount', () => {
    expect(holds('frontdesk', 'pos', 'checkout')).toBe(true)
    expect(holds('frontdesk', 'pos', 'discount')).toBe(true)
    expect(holds('frontdesk', 'pos', 'void')).toBe(false)
  })

  it('keeps stock:adjust away from front desk while granting stock:read', () => {
    expect(holds('frontdesk', 'stock', 'read')).toBe(true)
    expect(holds('frontdesk', 'stock', 'adjust')).toBe(false)
  })
})
