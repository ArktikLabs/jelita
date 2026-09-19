import { roles, type SalonRole } from './permissions'

export type NavGroup = 'Operasional' | 'Keuangan' | 'Katalog' | 'Pengelolaan'

/** Icon NAMES, resolved to lucide components on the client (app-sidebar.tsx).
 *  Strings here keep the server payload a list of strings, not components. */
export type NavIcon =
  | 'dashboard' | 'pos' | 'calendar' | 'customers' | 'receipt' | 'percent'
  | 'wallet' | 'scissors' | 'package' | 'staff' | 'branch' | 'bell' | 'settings'

export type NavItem = {
  href: string
  label: string
  icon: NavIcon
  /** Absent means the item sits above every group (Dasbor). */
  group?: NavGroup
  /** The permission the destination page's own guard requires. */
  require?: { resource: string; action: string }
}

/** What crosses to the client: nothing a stylist's browser has no use for. */
export type ClientNavItem = { href: string; label: string; icon: NavIcon }
export type NavSection = { label: NavGroup | null; items: ClientNavItem[] }

/** Render order of the groups. Daily work first, rare admin last. */
export const NAV_GROUPS: readonly NavGroup[] = ['Operasional', 'Keuangan', 'Katalog', 'Pengelolaan']

/**
 * Each entry's `require` mirrors the guard on the page it links to. Deriving
 * visibility from lib/permissions.ts rather than hardcoding a role list means
 * a permission change moves the link and the guard together -- a hardcoded
 * list drifts, and the failure is a nav item that redirects the moment you
 * click it.
 */
export const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dasbor', icon: 'dashboard' },
  { href: '/dashboard/pos', label: 'Kasir', icon: 'pos', group: 'Operasional', require: { resource: 'pos', action: 'checkout' } },
  { href: '/dashboard/bookings', label: 'Janji temu', icon: 'calendar', group: 'Operasional', require: { resource: 'booking', action: 'read' } },
  { href: '/dashboard/customers', label: 'Pelanggan', icon: 'customers', group: 'Operasional', require: { resource: 'customer', action: 'read' } },
  { href: '/dashboard/transactions', label: 'Transaksi', icon: 'receipt', group: 'Keuangan', require: { resource: 'pos', action: 'checkout' } },
  { href: '/dashboard/commissions', label: 'Komisi', icon: 'percent', group: 'Keuangan', require: { resource: 'commission', action: 'read:own' } },
  { href: '/dashboard/payroll', label: 'Penggajian', icon: 'wallet', group: 'Keuangan', require: { resource: 'payroll', action: 'read' } },
  { href: '/dashboard/services', label: 'Layanan', icon: 'scissors', group: 'Katalog', require: { resource: 'service', action: 'update' } },
  { href: '/dashboard/products', label: 'Produk', icon: 'package', group: 'Katalog', require: { resource: 'product', action: 'read' } },
  { href: '/dashboard/staff', label: 'Staf', icon: 'staff', group: 'Pengelolaan', require: { resource: 'staff', action: 'read' } },
  { href: '/dashboard/branches', label: 'Cabang', icon: 'branch', group: 'Pengelolaan', require: { resource: 'branch', action: 'update' } },
  { href: '/dashboard/notifications', label: 'Notifikasi', icon: 'bell', group: 'Pengelolaan', require: { resource: 'notification', action: 'read' } },
  { href: '/dashboard/settings', label: 'Pengaturan', icon: 'settings', group: 'Pengelolaan', require: { resource: 'settings', action: 'update' } },
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

/**
 * The visible items in sidebar order: ungrouped first (label null), then each
 * group in NAV_GROUPS order. A group the role cannot see anything in is
 * omitted rather than rendered as an empty heading.
 */
export function groupedNav(roleCsv: string): NavSection[] {
  const visible = visibleNav(roleCsv)
  const strip = ({ href, label, icon }: NavItem): ClientNavItem => ({ href, label, icon })
  const sections: NavSection[] = []
  const top = visible.filter((i) => !i.group).map(strip)
  if (top.length) sections.push({ label: null, items: top })
  for (const group of NAV_GROUPS) {
    const items = visible.filter((i) => i.group === group).map(strip)
    if (items.length) sections.push({ label: group, items })
  }
  return sections
}

/**
 * Which nav item a pathname belongs to. Prefix match so /customers/<id> still
 * highlights Pelanggan, guarded on a `/` boundary so /services never lights
 * up /service-x. Dasbor is exact only: every dashboard page starts with
 * /dashboard, and lighting it everywhere told the user nothing.
 */
export function isActive(pathname: string, href: string) {
  if (href === '/dashboard') return pathname === href
  return pathname === href || pathname.startsWith(`${href}/`)
}
