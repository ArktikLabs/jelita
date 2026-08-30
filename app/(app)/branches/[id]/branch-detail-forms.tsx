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
  // Controlled, not `defaultValue` + a data-derived `key`: a save that changes
  // any of these fields re-renders this same component with fresh props from
  // the revalidated page. An uncontrolled input would either warn (base-ui
  // flags a post-mount `defaultValue` change) or, if remounted via key, reset
  // to `{}` and lose the `state.done` "Tersimpan." message it just received.
  const [name, setName] = useState(profile.name)
  const [address, setAddress] = useState(profile.address ?? '')
  const [phone, setPhone] = useState(profile.phone ?? '')

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
        <Input
          id="name" name="name" value={name}
          onChange={(e) => setName(e.target.value)} required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="address">Alamat</Label>
        <Input id="address" name="address" value={address} onChange={(e) => setAddress(e.target.value)} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="phone">Telepon</Label>
        <Input id="phone" name="phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? 'Menyimpan…' : 'Simpan'}
      </Button>
    </form>
  )
}

export function BranchHoursForm({ teamId, hours }: { teamId: string; hours: HourRow[] }) {
  const [state, action, pending] = useActionState(updateBranchHoursAction, initial)
  // Controlled for the same reason as BranchDetailsForm above: no `key`, no
  // `defaultChecked`/`defaultValue` — this instance survives its own save.
  const [days, setDays] = useState(() => hours.map((h) => ({ ...h })))
  const patchDay = (weekday: number, patch: Partial<HourRow>) => {
    setDays((prev) => prev.map((d) => (d.weekday === weekday ? { ...d, ...patch } : d)))
  }

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
        {days.map((h) => (
          <div key={h.weekday} className="flex items-center gap-3">
            <span className="w-16 text-sm">{WEEKDAY_LABEL[h.weekday]}</span>
            <div className="flex items-center gap-2">
              <Checkbox
                id={`closed-${h.weekday}`}
                name={`closed-${h.weekday}`}
                checked={h.closed}
                onCheckedChange={(checked) => patchDay(h.weekday, { closed: checked })}
              />
              <Label htmlFor={`closed-${h.weekday}`} className="text-sm text-muted-foreground">
                Tutup
              </Label>
            </div>
            <Input
              type="time"
              name={`opens-${h.weekday}`}
              value={h.opensAt}
              onChange={(e) => patchDay(h.weekday, { opensAt: e.target.value })}
              // readOnly, not disabled: a disabled input submits nothing, so
              // closing a day made the action fall back to 09:00/21:00 and
              // destroy that day's stored hours on save. Read-only keeps the
              // values in the payload so a close-and-reopen is lossless.
              readOnly={h.closed}
              className="w-28 read-only:opacity-50"
            />
            <span className="text-sm text-muted-foreground">—</span>
            <Input
              type="time"
              name={`closes-${h.weekday}`}
              value={h.closesAt}
              onChange={(e) => patchDay(h.weekday, { closesAt: e.target.value })}
              readOnly={h.closed}
              className="w-28 read-only:opacity-50"
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
      {/* Without this the write succeeded silently: the page did not
          revalidate, the button still said "Nonaktifkan cabang", and a second
          click reported "Ini satu-satunya cabang aktif" — an error about the
          state the first click had created. */}
      {state.done && (
        <Alert>
          <AlertDescription>Status cabang diperbarui.</AlertDescription>
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
