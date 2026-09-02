'use client'

import { useActionState } from 'react'
import { setCustomerActiveAction, updateCustomerAction } from '../actions'
import type { FormState } from '@/lib/form-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Alert, AlertDescription } from '@/components/ui/alert'

const initial: FormState = {}

// Only the fields each form renders — props to a client component are
// serialised into the RSC payload whether they are rendered or not.
type DetailInput = {
  id: string
  name: string
  phone: string | null
  notes: string | null
}

export function CustomerDetailForm({ customer }: { customer: DetailInput }) {
  const [state, action, pending] = useActionState(updateCustomerAction, initial)

  return (
    <form action={action} className="space-y-4">
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      {state.done && (
        <Alert><AlertDescription>Pelanggan diperbarui.</AlertDescription></Alert>
      )}
      <input type="hidden" name="customerId" value={customer.id} />
      <div className="space-y-2">
        <Label htmlFor="name">Nama</Label>
        <Input id="name" name="name" defaultValue={customer.name} required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="phone">Nomor WhatsApp</Label>
        <Input id="phone" name="phone" defaultValue={customer.phone ?? ''} placeholder="0812…" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="notes">Catatan</Label>
        <Textarea id="notes" name="notes" defaultValue={customer.notes ?? ''} />
      </div>
      <Button type="submit" disabled={pending}>Simpan</Button>
    </form>
  )
}

export function CustomerStatusForm({ customer }: { customer: { id: string; active: boolean } }) {
  const [state, action, pending] = useActionState(setCustomerActiveAction, initial)

  return (
    <form action={action} className="space-y-4">
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      <input type="hidden" name="customerId" value={customer.id} />
      <input type="hidden" name="active" value={customer.active ? 'false' : 'true'} />
      <Button type="submit" variant={customer.active ? 'destructive' : 'default'} disabled={pending}>
        {customer.active ? 'Nonaktifkan pelanggan' : 'Aktifkan pelanggan'}
      </Button>
    </form>
  )
}
