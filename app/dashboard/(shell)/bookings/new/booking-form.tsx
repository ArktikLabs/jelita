'use client'

import { useActionState } from 'react'
import { createBookingAction } from '../actions'
import type { FormState } from '@/lib/form-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'

const initial: FormState = {}

/**
 * Step two: the slots are already computed on the server, so this only
 * collects the customer and which of those slots they want.
 *
 * The times are radio buttons rather than a select because the value posted
 * must be one the server offered -- and createBooking recomputes availability
 * anyway, so a hand-crafted post is refused rather than trusted.
 */
export function BookingForm({
  serviceId, staffUserId, slots,
}: {
  serviceId: string
  staffUserId: string
  slots: string[]
}) {
  const [state, action, pending] = useActionState(createBookingAction, initial)

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="serviceId" value={serviceId} />
      <input type="hidden" name="staffUserId" value={staffUserId} />
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Jam</legend>
        <div className="flex flex-wrap gap-2">
          {slots.map((s) => (
            <label
              key={s}
              className="flex items-center gap-1 rounded-md border px-2 py-1 text-sm"
            >
              <input type="radio" name="startsAt" value={s} required />
              {s.slice(11)}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="name">Nama pelanggan</Label>
          <Input id="name" name="name" required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="phone">Nomor telepon</Label>
          <Input id="phone" name="phone" placeholder="0812xxxxxxx" required />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="note">Catatan</Label>
        <Input id="note" name="note" />
      </div>

      <Button type="submit" disabled={pending}>
        {pending ? 'Menyimpan…' : 'Buat janji temu'}
      </Button>
    </form>
  )
}
