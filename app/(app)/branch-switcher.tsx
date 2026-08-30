'use client'

import { startTransition, useActionState } from 'react'
import { switchBranchAction } from './actions'
import type { FormState } from '@/lib/form-state'
import type { BranchRow } from '@/lib/branch'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'

const initial: FormState = {}

// State lives in the label, not a badge, so it survives being read out of a
// closed-branch history view: "Cabang Lama — Nonaktif" tells an admin where
// they are standing without a second UI element to notice.
function branchLabel(b: BranchRow) {
  if (!b.active) return `${b.name} — Nonaktif`
  if (!b.withinCap) return `${b.name} — Terkunci`
  return b.name
}

export function BranchSwitcher({
  branches, activeTeamId, canSwitch,
}: {
  branches: BranchRow[]
  activeTeamId: string | null
  canSwitch: boolean
}) {
  const [state, action, pending] = useActionState(switchBranchAction, initial)

  if (!canSwitch) {
    const active = branches.find((b) => b.teamId === activeTeamId)
    return <span className="text-sm text-muted-foreground">{active ? branchLabel(active) : '—'}</span>
  }

  return (
    <div className="flex items-center gap-2">
      {/* Remounted on every successful switch (activeTeamId changes only after
          revalidatePath re-renders the layout with the new session), so the
          uncontrolled defaultValue always starts from the current branch. */}
      <Select
        key={activeTeamId}
        items={branches.map((b) => ({ label: branchLabel(b), value: b.teamId }))}
        defaultValue={activeTeamId ?? undefined}
        disabled={pending}
        // Built and dispatched directly rather than via a hidden input +
        // requestSubmit(): the hidden input's DOM value update from base-ui
        // is a React state update that hasn't necessarily committed yet when
        // a synchronous requestSubmit() reads the form, so it can submit the
        // PREVIOUS value — confirmed while testing this component.
        onValueChange={(teamId) => {
          const fd = new FormData()
          fd.set('teamId', teamId ?? '')
          startTransition(() => action(fd))
        }}
      >
        <SelectTrigger size="sm" className="w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {branches.map((b) => (
            <SelectItem key={b.teamId} value={b.teamId}>
              {branchLabel(b)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {state.error && <span className="text-xs text-destructive">{state.error}</span>}
    </div>
  )
}
