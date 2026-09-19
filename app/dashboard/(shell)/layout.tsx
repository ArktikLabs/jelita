// app/dashboard/(shell)/layout.tsx
import { headers } from 'next/headers'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { requirePageOrg } from '@/lib/session'
import { groupedNav } from '@/lib/nav'
import { auth } from '@/lib/auth'
import { branchesOf } from '@/lib/branch'
import { branchLabel } from '@/lib/branch-label'
import { salonSettings } from '@/lib/service'
import { themeOf, themeScript, themeVars } from '@/lib/theme'
import {
  SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider,
} from '@/components/ui/sidebar'
import { AppSidebar } from './app-sidebar'
import { ShellHeader } from './shell-header'
import { BranchIdentity, BranchSwitcher } from './branch-switcher'
import { ThemeApplier } from './theme-applier'

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await requirePageOrg()
  const activeTeamId = session.session.activeTeamId ?? null
  const { success: canSwitch } = await auth.api.hasPermission({
    headers: await headers(),
    body: { permissions: { branch: ['switch'] } },
  })
  // A role that cannot switch must never RECEIVE the branch list: props to a
  // client component are serialized into the RSC payload whether or not they
  // are rendered, so passing the whole table and letting the component pick one
  // label handed front desk and stylists every branch's name, address, phone
  // and lock state on every page — the very table spec §8 guards /branches to
  // keep from them. They get one row, resolved and rendered on the server.
  const [branches, settings, { rows: orgRows }, { rows: memberRows }] = await Promise.all([
    canSwitch
      ? branchesOf(session.organizationId)
      : activeTeamId ? branchesOf(session.organizationId, activeTeamId) : Promise.resolve([]),
    salonSettings(session.organizationId),
    db.execute(sql`select name, slug from organizations where id = ${session.organizationId}`),
    // The caller's role, read once, decides which links appear. Showing a link
    // whose page would redirect is worse than showing none -- it reads as a
    // broken app rather than an unavailable feature.
    db.execute(sql`
      select role from members
       where user_id = ${session.user.id}
         and organization_id = ${session.organizationId}`),
  ])
  const org = orgRows[0] as { name: string; slug: string }
  const sections = groupedNav((memberRows[0] as { role?: string })?.role ?? '')
  const preset = themeOf(settings.theme)
  const vars = themeVars(preset, settings.brandColor)

  // Narrowed for the same reason the non-switching roles get one row: the
  // switcher needs an id and a label; address, phone and staffCount are the
  // /branches table's business, not the sidebar's.
  const branchOptions = branches.map(
    ({ teamId, name, active, withinCap }) => ({ teamId, name, active, withinCap }),
  )
  const salon = {
    name: org.name, slug: org.slug,
    hasLogo: settings.hasLogo, logoVersion: settings.logoVersion,
  }
  const branch = canSwitch ? (
    <BranchSwitcher salon={salon} branches={branchOptions} activeTeamId={activeTeamId} />
  ) : (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton size="lg" render={<div />}>
          <BranchIdentity salon={salon} label={branches[0] ? branchLabel(branches[0]) : '—'} />
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  )

  return (
    <SidebarProvider>
      {/* First in the stream so <html> carries the theme before the shell
          paints -- no light-to-dark flash, and portalled menus inherit it.
          Content is JSON-encoded in themeScript, never raw. */}
      <script dangerouslySetInnerHTML={{ __html: themeScript(preset.mode, vars) }} />
      <ThemeApplier mode={preset.mode} vars={vars} />
      <AppSidebar
        sections={sections}
        userName={session.user.name}
        branch={branch}
      />
      <SidebarInset>
        <ShellHeader sections={sections} />
        <div className="flex-1 p-6">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  )
}
