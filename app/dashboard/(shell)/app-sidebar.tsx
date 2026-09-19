// app/dashboard/(shell)/app-sidebar.tsx
'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Bell, Building2, CalendarDays, ChevronsUpDown, CreditCard, IdCard, LayoutDashboard,
  LogOut, Package, Percent, Receipt, Scissors, Settings, User, Users, Wallet,
} from 'lucide-react'
import type { NavIcon, NavSection } from '@/lib/nav'
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent,
  SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { signOutAction } from './actions'

/** Icon names from lib/nav.ts resolved here, on the client, so the server
 *  payload is strings and the import list is one place. */
const ICONS: Record<NavIcon, React.ComponentType<{ className?: string }>> = {
  dashboard: LayoutDashboard,
  pos: CreditCard,
  calendar: CalendarDays,
  customers: Users,
  receipt: Receipt,
  percent: Percent,
  wallet: Wallet,
  scissors: Scissors,
  package: Package,
  staff: IdCard,
  branch: Building2,
  bell: Bell,
  settings: Settings,
}

/** Prefix match so /customers/<id> still highlights Pelanggan, guarded on a
 *  boundary so /services never lights up /service-x. Dasbor is exact only. */
export function isActive(pathname: string, href: string) {
  if (href === '/dashboard') return pathname === href
  return pathname === href || pathname.startsWith(`${href}/`)
}

export function AppSidebar({
  sections, userName, branch,
}: {
  sections: NavSection[]
  userName: string
  branch: React.ReactNode
}) {
  const pathname = usePathname()
  const { isMobile, setOpenMobile } = useSidebar()
  // On a phone the sidebar is a drawer; a tap on a link should close it.
  const closeOnMobile = () => { if (isMobile) setOpenMobile(false) }

  return (
    <Sidebar className="print:hidden">
      <SidebarHeader>{branch}</SidebarHeader>

      <SidebarContent>
        {sections.map((section) => (
          <SidebarGroup key={section.label ?? 'top'}>
            {section.label && <SidebarGroupLabel>{section.label}</SidebarGroupLabel>}
            <SidebarGroupContent>
              <SidebarMenu>
                {section.items.map((item) => {
                  const Icon = ICONS[item.icon]
                  const active = isActive(pathname, item.href)
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        render={<Link href={item.href} aria-current={active ? 'page' : undefined} />}
                        isActive={active}
                        onClick={closeOnMobile}
                      >
                        <Icon className="size-4" />
                        <span>{item.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<SidebarMenuButton size="lg" />}
              >
                <span className="flex size-8 items-center justify-center rounded-full bg-sidebar-accent text-sidebar-accent-foreground text-sm font-medium">
                  {userName.charAt(0).toUpperCase()}
                </span>
                <span className="truncate text-sm">{userName}</span>
                <ChevronsUpDown className="ml-auto size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top" className="w-56">
                <DropdownMenuItem
                  render={<Link href="/dashboard/profile" onClick={closeOnMobile} />}
                >
                  <User className="size-4" />
                  Profil
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {/* The (auth) layout bounces a signed-in user away from /login,
                    so this is the only reachable way out of the app. */}
                <form action={signOutAction}>
                  <DropdownMenuItem nativeButton render={<button type="submit" className="w-full" />}>
                    <LogOut className="size-4" />
                    Keluar
                  </DropdownMenuItem>
                </form>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
