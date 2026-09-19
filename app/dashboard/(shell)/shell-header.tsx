// app/dashboard/(shell)/shell-header.tsx
'use client'

import { usePathname } from 'next/navigation'
import { isActive, type NavSection } from '@/lib/nav'
import { SidebarTrigger } from '@/components/ui/sidebar'

/**
 * The strip above the page: the drawer button on narrow screens and the
 * label of the section the user is in. Pages keep their own <h1>; this is a
 * breadcrumb-level cue, not a replacement.
 */
export function ShellHeader({ sections }: { sections: NavSection[] }) {
  const pathname = usePathname()
  const current = sections.flatMap((s) => s.items).find((i) => isActive(pathname, i.href))

  return (
    <header className="flex h-12 items-center gap-2 border-b px-4 print:hidden">
      <SidebarTrigger className="md:hidden" aria-label="Buka menu" />
      {/* Empty rather than a fallback: /dashboard/profile is reachable from the
          user menu and is not a nav item, and a header that says "Dasbor" there
          is a wrong breadcrumb, not a helpful one. */}
      <span className="text-sm text-muted-foreground">{current?.label ?? ''}</span>
    </header>
  )
}
