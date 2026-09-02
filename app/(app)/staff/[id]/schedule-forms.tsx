'use client'

import { useActionState, useState } from 'react'
import {
  addScheduleExceptionAction, addTimeOffAction, removeScheduleExceptionAction,
  removeTimeOffAction, updateStaffScheduleAction,
} from '../actions'
import type { FormState } from '@/lib/form-state'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'

const initial: FormState = {}

// Sunday first, matching extract(dow) and staff_hours.weekday.
const WEEKDAY_LABEL = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu']

type Day = { weekday: number; closed: boolean; opensAt: string; closesAt: string }
type Exception = {
  onDate: string; closed: boolean
  opensAt: string | null; closesAt: string | null; note: string | null
}
type Block = {
  id: string; onDate: string; startsAt: string; endsAt: string; note: string | null
}

export function StaffScheduleForm({ userId, days }: { userId: string; days: Day[] }) {
  const [state, action, pending] = useActionState(updateStaffScheduleAction, initial)
  // Controlled, like BranchHoursForm: this instance survives its own save.
  const [rows, setRows] = useState(() => days.map((d) => ({ ...d })))
  const patch = (weekday: number, next: Partial<Day>) =>
    setRows((prev) => prev.map((d) => (d.weekday === weekday ? { ...d, ...next } : d)))

  return (
    <form action={action} className="space-y-4">
      {state.error && (
        <Alert variant="destructive"><AlertDescription>{state.error}</AlertDescription></Alert>
      )}
      {state.done && <Alert><AlertDescription>Tersimpan.</AlertDescription></Alert>}
      <input type="hidden" name="userId" value={userId} />
      <div className="space-y-3">
        {rows.map((d) => (
          <div key={d.weekday} className="flex items-center gap-3">
            <span className="w-16 text-sm">{WEEKDAY_LABEL[d.weekday]}</span>
            <div className="flex items-center gap-2">
              <Checkbox
                id={`sched-closed-${d.weekday}`}
                name={`closed-${d.weekday}`}
                checked={d.closed}
                onCheckedChange={(checked) => patch(d.weekday, { closed: Boolean(checked) })}
              />
              <Label htmlFor={`sched-closed-${d.weekday}`} className="text-sm text-muted-foreground">
                Libur
              </Label>
            </div>
            <Input
              type="time" name={`opens-${d.weekday}`} value={d.opensAt}
              onChange={(e) => patch(d.weekday, { opensAt: e.target.value })}
              // readOnly, never disabled: a disabled input submits nothing, so
              // marking a day off would drop its hours from the payload and
              // wipe them on save. The branch hours form fixed this once.
              readOnly={d.closed}
              className="w-28 read-only:opacity-50"
            />
            <span className="text-sm text-muted-foreground">—</span>
            <Input
              type="time" name={`closes-${d.weekday}`} value={d.closesAt}
              onChange={(e) => patch(d.weekday, { closesAt: e.target.value })}
              readOnly={d.closed}
              className="w-28 read-only:opacity-50"
            />
          </div>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">
        Jam ini dipotong jam buka cabang — staf tidak tersedia saat cabang tutup.
      </p>
      <Button type="submit" disabled={pending}>Simpan jadwal</Button>
    </form>
  )
}

export function ScheduleExceptionsForm({
  userId, exceptions,
}: { userId: string; exceptions: Exception[] }) {
  const [state, action, pending] = useActionState(addScheduleExceptionAction, initial)
  const [, removeAction] = useActionState(removeScheduleExceptionAction, initial)
  const [closed, setClosed] = useState(true)

  return (
    <div className="space-y-4">
      {exceptions.length > 0 && (
        <ul className="space-y-1 text-sm">
          {exceptions.map((e) => (
            <li key={e.onDate} className="flex items-center gap-3">
              <span className="w-28">{e.onDate}</span>
              <span className="text-muted-foreground">
                {e.closed ? 'Libur' : `${e.opensAt}–${e.closesAt}`}
                {e.note ? ` · ${e.note}` : ''}
              </span>
              <form action={removeAction}>
                <input type="hidden" name="userId" value={userId} />
                <input type="hidden" name="onDate" value={e.onDate} />
                <Button type="submit" variant="ghost" size="sm">Hapus</Button>
              </form>
            </li>
          ))}
        </ul>
      )}
      <form action={action} className="space-y-3">
        {state.error && (
          <Alert variant="destructive"><AlertDescription>{state.error}</AlertDescription></Alert>
        )}
        <input type="hidden" name="userId" value={userId} />
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="exc-date">Tanggal</Label>
            <Input id="exc-date" type="date" name="onDate" required className="w-40" />
          </div>
          <div className="flex items-center gap-2 pb-2">
            <Checkbox
              id="exc-closed" name="closed" checked={closed}
              onCheckedChange={(v) => setClosed(Boolean(v))}
            />
            <Label htmlFor="exc-closed" className="text-sm">Libur</Label>
          </div>
          {!closed && (
            <>
              <div className="space-y-1">
                <Label htmlFor="exc-opens">Mulai</Label>
                <Input id="exc-opens" type="time" name="opensAt" className="w-28" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="exc-closes">Selesai</Label>
                <Input id="exc-closes" type="time" name="closesAt" className="w-28" />
              </div>
            </>
          )}
          <div className="space-y-1">
            <Label htmlFor="exc-note">Catatan</Label>
            <Input id="exc-note" name="note" placeholder="cuti, training…" className="w-44" />
          </div>
          <Button type="submit" disabled={pending}>Tambah</Button>
        </div>
      </form>
    </div>
  )
}

export function TimeOffForm({ userId, blocks }: { userId: string; blocks: Block[] }) {
  const [state, action, pending] = useActionState(addTimeOffAction, initial)
  const [, removeAction] = useActionState(removeTimeOffAction, initial)

  return (
    <div className="space-y-4">
      {blocks.length > 0 && (
        <ul className="space-y-1 text-sm">
          {blocks.map((b) => (
            <li key={b.id} className="flex items-center gap-3">
              <span className="w-28">{b.onDate}</span>
              <span className="text-muted-foreground">
                {b.startsAt}–{b.endsAt}{b.note ? ` · ${b.note}` : ''}
              </span>
              <form action={removeAction}>
                <input type="hidden" name="userId" value={userId} />
                <input type="hidden" name="blockId" value={b.id} />
                <Button type="submit" variant="ghost" size="sm">Hapus</Button>
              </form>
            </li>
          ))}
        </ul>
      )}
      <form action={action} className="space-y-3">
        {state.error && (
          <Alert variant="destructive"><AlertDescription>{state.error}</AlertDescription></Alert>
        )}
        <input type="hidden" name="userId" value={userId} />
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="off-date">Tanggal</Label>
            <Input id="off-date" type="date" name="onDate" required className="w-40" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="off-start">Mulai</Label>
            <Input id="off-start" type="time" name="startsAt" required className="w-28" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="off-end">Selesai</Label>
            <Input id="off-end" type="time" name="endsAt" required className="w-28" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="off-note">Catatan</Label>
            <Input id="off-note" name="note" className="w-44" />
          </div>
          <Button type="submit" disabled={pending}>Tambah</Button>
        </div>
      </form>
    </div>
  )
}
