'use client'

import { useActionState, useState } from 'react'
import {
  updateBranchDetailsAction, updateBranchHoursAction,
  deactivateBranchAction, reactivateBranchAction,
} from '../actions'
import type { FormState } from '@/lib/form-state'
import type { BranchRow, HourRow } from '@/lib/branch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Alert, AlertDescription } from '@/components/ui/alert'

const initial: FormState = {}

const WEEKDAY_LABEL = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu']

export function BranchDetailsForm({ profile }: { profile: BranchRow }) {
  const [state, action, pending] = useActionState(updateBranchDetailsAction, initial)
  return (
    <form action={action} className="space-y-4">
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      {state.done && (
        <Alert>
          <AlertDescription>Tersimpan.</AlertDescription>
        </Alert>
      )}
      <input type="hidden" name="teamId" value={profile.teamId} />
      <div className="space-y-2">
        <Label htmlFor="name">Nama cabang</Label>
        <Input id="name" name="name" defaultValue={profile.name} required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="address">Alamat</Label>
        <Input id="address" name="address" defaultValue={profile.address ?? ''} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="phone">Telepon</Label>
        <Input id="phone" name="phone" defaultValue={profile.phone ?? ''} />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? 'Menyimpan…' : 'Simpan'}
      </Button>
    </form>
  )
}

export function BranchHoursForm({ teamId, hours }: { teamId: string; hours: HourRow[] }) {
  const [state, action, pending] = useActionState(updateBranchHoursAction, initial)
  const [closed, setClosed] = useState(() => hours.map((h) => h.closed))

  return (
    <form action={action} className="space-y-4">
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      {state.done && (
        <Alert>
          <AlertDescription>Tersimpan.</AlertDescription>
        </Alert>
      )}
      <input type="hidden" name="teamId" value={teamId} />
      <div className="space-y-3">
        {hours.map((h) => (
          <div key={h.weekday} className="flex items-center gap-3">
            <span className="w-16 text-sm">{WEEKDAY_LABEL[h.weekday]}</span>
            <div className="flex items-center gap-2">
              <Checkbox
                id={`closed-${h.weekday}`}
                name={`closed-${h.weekday}`}
                defaultChecked={h.closed}
                onCheckedChange={(checked) => {
                  setClosed((prev) => {
                    const next = [...prev]
                    next[h.weekday] = checked
                    return next
                  })
                }}
              />
              <Label htmlFor={`closed-${h.weekday}`} className="text-sm text-muted-foreground">
                Tutup
              </Label>
            </div>
            <Input
              type="time"
              name={`opens-${h.weekday}`}
              defaultValue={h.opensAt}
              disabled={closed[h.weekday]}
              className="w-28"
            />
            <span className="text-sm text-muted-foreground">—</span>
            <Input
              type="time"
              name={`closes-${h.weekday}`}
              defaultValue={h.closesAt}
              disabled={closed[h.weekday]}
              className="w-28"
            />
          </div>
        ))}
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? 'Menyimpan…' : 'Simpan jam'}
      </Button>
    </form>
  )
}

export function BranchStatusForm({ teamId, active }: { teamId: string; active: boolean }) {
  const statusAction = active ? deactivateBranchAction : reactivateBranchAction
  const [state, action, pending] = useActionState(statusAction, initial)
  return (
    <form action={action} className="space-y-4">
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      <input type="hidden" name="teamId" value={teamId} />
      <Button type="submit" variant={active ? 'destructive' : 'default'} disabled={pending}>
        {pending
          ? 'Memproses…'
          : active ? 'Nonaktifkan cabang' : 'Aktifkan cabang'}
      </Button>
    </form>
  )
}
