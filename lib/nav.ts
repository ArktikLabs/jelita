import { roles, type SalonRole } from './permissions'

export type NavItem = {
  href: string
  label: string
  /** The permission the destination page's own guard requires. */
  require?: { resource: string; action: string }
}

/**
 * Each entry's `require` mirrors the guard on the page it links to. Deriving
 * visibility from lib/permissions.ts rather than hardcoding a role list means
 * a permission change moves the link and the guard together -- a hardcoded
 * list drifts, and the failure is a nav item that redirects the moment you
 * click it.
 */
export const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dasbor' },
  { href: '/customers', label: 'Pelanggan', require: { resource: 'customer', action: 'read' } },
  { href: '/services', label: 'Layanan', require: { resource: 'service', action: 'update' } },
  { href: '/staff', label: 'Staf', require: { resource: 'staff', action: 'read' } },
  { href: '/branches', label: 'Cabang', require: { resource: 'branch', action: 'update' } },
]

/**
 * `members.role` is a comma-separated list -- better-auth splits it on ',' in
 * hasPermissionFn -- so a member may hold several roles and the union of their
 * statements applies.
 */
export function visibleNav(roleCsv: string): NavItem[] {
  const held = roleCsv.split(',').map((r) => r.trim()).filter(Boolean)
  const granted = new Set<string>()
  for (const name of held) {
    const role = roles[name as SalonRole]
    if (!role) continue // a custom role this build does not know about
    for (const [resource, actions] of Object.entries(role.statements ?? {})) {
      for (const action of actions as readonly string[]) granted.add(`${resource}:${action}`)
    }
  }
  return NAV.filter((item) =>
    !item.require || granted.has(`${item.require.resource}:${item.require.action}`))
}
