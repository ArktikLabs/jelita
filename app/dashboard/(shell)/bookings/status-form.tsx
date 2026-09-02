'use client'

import { useActionState } from 'react'
import { setBookingStatusAction } from './actions'
import type { FormState } from '@/lib/form-state'
import { Button } from '@/components/ui/button'

const initial: FormState = {}

const LABEL: Record<string, string> = {
  confirmed: 'Konfirmasi',
  completed: 'Selesai',
  no_show: 'Tidak datang',
  cancelled: 'Batalkan',
}

/** pending -> confirmed | cancelled; confirmed -> completed | no_show |
 *  cancelled. Terminal statuses offer nothing, mirroring lib/booking.ts's
 *  NEXT table -- which is the one that actually refuses a bad transition. */
const NEXT: Record<string, string[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['completed', 'no_show', 'cancelled'],
}

export function StatusActions({ id, status }: { id: string; status: string }) {
  const [state, action, pending] = useActionState(setBookingStatusAction, initial)
  const next = NEXT[status] ?? []

  if (next.length === 0) return null
  return (
    <form action={action} className="flex items-center gap-1">
      <input type="hidden" name="id" value={id} />
      {next.map((s) => (
        <Button
          key={s}
          type="submit"
          name="status"
          value={s}
          size="sm"
          variant={s === 'cancelled' ? 'outline' : 'default'}
          disabled={pending}
        >
          {LABEL[s]}
        </Button>
      ))}
      {state.error && <span className="text-sm text-destructive">{state.error}</span>}
    </form>
  )
}
