'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { NavItem } from '@/lib/nav'

/**
 * Receives only href and label -- props to a client component are serialised
 * into the RSC payload of every page, and the `require` clause is a
 * server-side concern.
 */
export function MainNav({ items }: { items: { href: string; label: string }[] }) {
  const pathname = usePathname()

  return (
    <nav className="flex items-center gap-1">
      {items.map((item) => {
        // Prefix match so /customers/<id> still highlights Pelanggan, but
        // guarded on a boundary so /services never lights up /service-x.
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`)
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={[
              'rounded-md px-3 py-1.5 text-sm transition-colors',
              active
                ? 'bg-accent text-accent-foreground font-medium'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            ].join(' ')}
          >
            {item.label}
          </Link>
        )
      })}
    </nav>
  )
}

export type { NavItem }
