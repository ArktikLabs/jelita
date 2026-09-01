'use client'

import { useActionState } from 'react'
import { createCustomerAction } from '../actions'
import type { FormState } from '@/lib/form-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Alert, AlertDescription } from '@/components/ui/alert'

const initial: FormState = {}

export function CustomerCreateForm() {
  const [state, action, pending] = useActionState(createCustomerAction, initial)

  return (
    <form action={action} className="space-y-4">
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      <div className="space-y-2">
        <Label htmlFor="name">Nama</Label>
        <Input id="name" name="name" required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="phone">Nomor WhatsApp</Label>
        <Input id="phone" name="phone" placeholder="0812…" />
        <p className="text-sm text-muted-foreground">
          Boleh dikosongkan untuk pelanggan tanpa nomor.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="notes">Catatan</Label>
        <Textarea id="notes" name="notes" placeholder="Formula warna, alergi…" />
      </div>
      <Button type="submit" disabled={pending}>Simpan</Button>
    </form>
  )
}
