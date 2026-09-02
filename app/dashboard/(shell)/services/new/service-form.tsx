'use client'

import { useActionState } from 'react'
import { createServiceAction } from '../actions'
import type { FormState } from '@/lib/form-state'
import type { CurrencyCode } from '@/lib/money'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'

const initial: FormState = {}

export function ServiceCreateForm({
  categories, currency,
}: {
  categories: { id: string; name: string }[]
  currency: CurrencyCode
}) {
  const [state, action, pending] = useActionState(createServiceAction, initial)

  return (
    <form action={action} className="space-y-4">
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      <div className="space-y-2">
        <Label htmlFor="name">Nama layanan</Label>
        <Input id="name" name="name" required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="categoryId">Kategori</Label>
        <Select name="categoryId">
          <SelectTrigger id="categoryId" className="w-full">
            <SelectValue placeholder="Tanpa kategori" />
          </SelectTrigger>
          <SelectContent>
            {categories.map((c) => (
              <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="durationMinutes">Durasi (menit)</Label>
        <Input id="durationMinutes" name="durationMinutes" type="number" min={1} required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="price">Harga ({currency})</Label>
        <Input id="price" name="price" required />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? 'Menyimpan…' : 'Simpan'}
      </Button>
    </form>
  )
}
