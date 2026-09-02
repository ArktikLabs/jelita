'use client'

import { useActionState } from 'react'
import { publicBookAction } from './actions'
import type { FormState } from '@/lib/form-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'

const initial: FormState & { bookedAt?: string } = {}

/**
 * Phase two. The slots were computed on the server and the chosen one is
 * re-checked there before anything is written, so this form carries no trust:
 * salon, branch and service ride along as hidden fields purely so the action
 * can resolve them again.
 */
export function BookForm({
  salon, teamId, serviceId, staffUserId, slots, summary,
}: {
  salon: string
  teamId: string
  serviceId: string
  staffUserId: string
  slots: string[]
  summary: string
}) {
  const [state, action, pending] = useActionState(publicBookAction, initial)

  if (state.done) {
    return (
      <div className="space-y-3 rounded-lg border p-4">
        <p className="font-medium">Permintaan janji temu terkirim.</p>
        <p className="text-sm text-muted-foreground">
          {summary} — {state.bookedAt?.slice(0, 10)} pukul {state.bookedAt?.slice(11)}
        </p>
        <p className="text-sm text-muted-foreground">
          Salon akan mengonfirmasi lewat WhatsApp.
        </p>
      </div>
    )
  }

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="salon" value={salon} />
      <input type="hidden" name="teamId" value={teamId} />
      <input type="hidden" name="serviceId" value={serviceId} />
      <input type="hidden" name="staffUserId" value={staffUserId} />
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Pilih jam</legend>
        <div className="flex flex-wrap gap-2">
          {slots.map((s) => (
            <label key={s} className="flex items-center gap-1 rounded-md border px-2 py-1 text-sm">
              <input type="radio" name="startsAt" value={s} required />
              {s.slice(11)}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="name">Nama</Label>
          <Input id="name" name="name" required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="phone">Nomor WhatsApp</Label>
          <Input id="phone" name="phone" placeholder="0812xxxxxxx" required />
        </div>
      </div>

      <Button type="submit" disabled={pending}>
        {pending ? 'Mengirim…' : 'Pesan sekarang'}
      </Button>
    </form>
  )
}
