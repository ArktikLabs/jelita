'use client'

import { startTransition, useActionState } from 'react'
import { switchBranchAction } from './actions'
import type { FormState } from '@/lib/form-state'
import type { BranchRow } from '@/lib/branch'
import { branchLabel } from '@/lib/branch-label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'

const initial: FormState = {}

// Rendered only for roles that hold branch:['switch'] — the layout resolves a
// single label on the server for everyone else, so the list never reaches a
// client component that could not act on it.
export function BranchSwitcher({
  branches, activeTeamId,
}: {
  // Exactly what an option needs: an id and what branchLabel reads. Anything
  // wider would ride into the RSC payload of every page in this layout.
  branches: Pick<BranchRow, 'teamId' | 'name' | 'active' | 'withinCap'>[]
  activeTeamId: string | null
}) {
  const [state, action, pending] = useActionState(switchBranchAction, initial)

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
