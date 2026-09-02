'use client'

import { useActionState } from 'react'
import { rescheduleAction } from '../actions'
import type { FormState } from '@/lib/form-state'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'

const initial: FormState = {}

export function RescheduleForm({
  id, slots, performers, staffUserId,
}: {
  id: string
  slots: string[]
  performers: { userId: string; name: string }[]
  staffUserId: string
}) {
  const [state, action, pending] = useActionState(rescheduleAction, initial)

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="id" value={id} />
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        <label htmlFor="staffUserId" className="text-sm font-medium">Staf</label>
        <select
          id="staffUserId"
          name="staffUserId"
          defaultValue={staffUserId}
          className="flex h-9 rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs"
        >
          {performers.map((p) => (
            <option key={p.userId} value={p.userId}>{p.name}</option>
          ))}
        </select>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Jam baru</legend>
        <div className="flex flex-wrap gap-2">
          {slots.map((s) => (
            <label key={s} className="flex items-center gap-1 rounded-md border px-2 py-1 text-sm">
              <input type="radio" name="startsAt" value={s} required />
              {s.slice(11)}
            </label>
          ))}
        </div>
      </fieldset>

      <Button type="submit" disabled={pending}>
        {pending ? 'Memindahkan…' : 'Pindahkan jadwal'}
      </Button>
    </form>
  )
}
