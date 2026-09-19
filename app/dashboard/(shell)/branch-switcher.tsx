'use client'

import { startTransition, useActionState } from 'react'
import { ChevronsUpDown } from 'lucide-react'
import { switchBranchAction } from './actions'
import type { FormState } from '@/lib/form-state'
import type { BranchRow } from '@/lib/branch'
import { branchLabel } from '@/lib/branch-label'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar'

const initial: FormState = {}

type Salon = { name: string; slug: string; hasLogo: boolean; logoVersion: string }

/**
 * The header row itself: salon mark, active branch in bold, salon name under
 * it. Rendered inside a SidebarMenuButton so the switcher and the static
 * version for non-switching roles look identical; only the chevron and the
 * menu differ.
 */
export function BranchIdentity({ salon, label, chevron = false }: {
  salon: Salon
  label: string
  chevron?: boolean
}) {
  return (
    <>
      {salon.hasLogo ? (
        // Served from object storage through our own route; next/image would
        // add an optimiser in front of a 50 KB file for nothing.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/salon/logo?salon=${salon.slug}&v=${salon.logoVersion}`}
          alt=""
          className="size-8 rounded-lg object-contain"
        />
      ) : (
        <span className="flex size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground text-sm font-semibold">
          {salon.name.charAt(0).toUpperCase() || 'J'}
        </span>
      )}
      <span className="grid flex-1 text-left text-sm leading-tight">
        <span className="truncate font-medium">{label}</span>
        <span className="truncate text-xs text-muted-foreground">{salon.name}</span>
      </span>
      {chevron && <ChevronsUpDown className="ml-auto size-4" />}
    </>
  )
}

/**
 * Rendered only for roles that hold branch:['switch'] — the layout renders a
 * static BranchIdentity for everyone else, so the list never reaches a client
 * component that could not act on it.
 */
export function BranchSwitcher({ salon, branches, activeTeamId }: {
  salon: Salon
  // Exactly what an option needs: an id and what branchLabel reads. Anything
  // wider would ride into the RSC payload of every page in this layout.
  branches: Pick<BranchRow, 'teamId' | 'name' | 'active' | 'withinCap'>[]
  activeTeamId: string | null
}) {
  const [state, action, pending] = useActionState(switchBranchAction, initial)
  const { isMobile } = useSidebar()
  const active = branches.find((b) => b.teamId === activeTeamId)
  const label = active ? branchLabel(active) : 'Pilih cabang'

  // Built and dispatched directly rather than via a form: the menu item is
  // the whole gesture, and the action guards itself server-side.
  const choose = (teamId: string) => {
    if (teamId === activeTeamId) return
    const fd = new FormData()
    fd.set('teamId', teamId)
    startTransition(() => action(fd))
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<SidebarMenuButton size="lg" disabled={pending} />}
          >
            <BranchIdentity salon={salon} label={label} chevron />
            {/* The visible row already shows the active branch and salon name;
                without this, aria-label would have replaced that accessible
                name entirely and a screen-reader user would never hear which
                branch is active. */}
            <span className="sr-only">Ganti cabang</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            side={isMobile ? 'bottom' : 'right'}
            sideOffset={4}
            className="w-(--anchor-width) min-w-56"
          >
            {/* DropdownMenuRadioGroup (base-ui Menu.RadioGroup) supplies the
                same MenuGroupContext DropdownMenuLabel needs, so it doubles as
                the wrapper the label requires and expresses the real
                single-choice semantics — DropdownMenuRadioItem renders its
                own check indicator, so the active branch is announced as
                checked to assistive tech instead of only shown visually. */}
            <DropdownMenuRadioGroup
              value={activeTeamId ?? ''}
              onValueChange={(v) => choose(String(v))}
            >
              <DropdownMenuLabel className="text-xs text-muted-foreground">Cabang</DropdownMenuLabel>
              {branches.map((b) => (
                <DropdownMenuRadioItem key={b.teamId} value={b.teamId} className="gap-2 p-2">
                  <span className="flex size-6 items-center justify-center rounded-sm border text-xs">
                    {b.name.charAt(0).toUpperCase()}
                  </span>
                  <span className="truncate">{branchLabel(b)}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {state.error && <p className="px-2 pt-1 text-xs text-destructive">{state.error}</p>}
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
