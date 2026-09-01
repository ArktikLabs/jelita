'use client'

import { useActionState, useState } from 'react'
import {
  updateServiceAction, setBranchOverrideAction,
  deactivateServiceAction, reactivateServiceAction,
} from '../actions'
import type { FormState } from '@/lib/form-state'
import type { ServiceRow, OverrideRow } from '@/lib/service'
import { toAmountInput, type CurrencyCode } from '@/lib/money'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'

const initial: FormState = {}

export function ServiceDetailForm({
  service, categories, currency,
}: {
  service: ServiceRow
  categories: { id: string; name: string }[]
  currency: CurrencyCode
}) {
  const [state, action, pending] = useActionState(updateServiceAction, initial)
  // Controlled, same reason as branch-detail-forms.tsx's BranchDetailsForm:
  // this instance survives its own save (revalidatePath re-renders the
  // server parent, not this component), so no defaultValue/key is used.
  const [name, setName] = useState(service.name)
  const [categoryId, setCategoryId] = useState(service.categoryId ?? '')
  const [duration, setDuration] = useState(String(service.durationMinutes))
  // toAmountInput, not formatMoney -- this is an editable field's value, and
  // formatMoney's currency-symbol output must never round-trip through
  // parseMoney on submit.
  const [price, setPrice] = useState(toAmountInput(service.price, currency))

  return (
    <form action={action} className="space-y-4">
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      {state.done && (
        <Alert>
          <AlertDescription>Layanan diperbarui.</AlertDescription>
        </Alert>
      )}
      <input type="hidden" name="id" value={service.id} />
      <div className="space-y-2">
        <Label htmlFor="name">Nama layanan</Label>
        <Input id="name" name="name" value={name} onChange={(e) => setName(e.target.value)} required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="categoryId">Kategori</Label>
        <Select name="categoryId" value={categoryId} onValueChange={(v) => setCategoryId(v ?? '')}>
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
        <Input
          id="durationMinutes" name="durationMinutes" type="number" min={1}
          value={duration} onChange={(e) => setDuration(e.target.value)} required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="price">Harga salon ({currency})</Label>
        <Input id="price" name="price" value={price} onChange={(e) => setPrice(e.target.value)} required />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? 'Menyimpan…' : 'Simpan'}
      </Button>
    </form>
  )
}

type OverrideInput = { teamId: string; branchName: string; price: string; offered: boolean }

export function OverridesForm({
  serviceId, currency, salonPrice, overrides,
}: {
  serviceId: string
  currency: CurrencyCode
  salonPrice: number
  overrides: OverrideRow[]
}) {
  const [state, action, pending] = useActionState(setBranchOverrideAction, initial)
  const [rows, setRows] = useState<OverrideInput[]>(() => overrides.map((o) => ({
    teamId: o.teamId,
    branchName: o.branchName,
    // Empty means INHERITS -- a null price must reach the field as an empty
    // string, never as a re-typed copy of the salon price.
    price: o.price === null ? '' : toAmountInput(o.price, currency),
    offered: o.offered,
  })))
  const patch = (teamId: string, next: Partial<OverrideInput>) => {
    setRows((prev) => prev.map((r) => (r.teamId === teamId ? { ...r, ...next } : r)))
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
          <AlertDescription>Harga per cabang diperbarui.</AlertDescription>
        </Alert>
      )}
      <input type="hidden" name="serviceId" value={serviceId} />
      <div className="space-y-4">
        {rows.map((r) => (
          <div key={r.teamId} className="space-y-2 rounded-md border p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{r.branchName}</span>
              <div className="flex items-center gap-2">
                <Checkbox
                  id={`offered-${r.teamId}`}
                  name={`offered-${r.teamId}`}
                  checked={r.offered}
                  onCheckedChange={(checked) => patch(r.teamId, { offered: checked === true })}
                />
                <Label htmlFor={`offered-${r.teamId}`} className="text-sm text-muted-foreground">
                  Ditawarkan di cabang ini
                </Label>
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`price-${r.teamId}`} className="text-xs text-muted-foreground">
                Harga khusus cabang ({currency}) -- kosongkan agar mengikuti harga salon
              </Label>
              <Input
                id={`price-${r.teamId}`}
                name={`price-${r.teamId}`}
                value={r.price}
                onChange={(e) => patch(r.teamId, { price: e.target.value })}
                placeholder={toAmountInput(salonPrice, currency)}
              />
            </div>
          </div>
        ))}
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? 'Menyimpan…' : 'Simpan harga cabang'}
      </Button>
    </form>
  )
}

export function ServiceStatusForm({ service }: { service: ServiceRow }) {
  const statusAction = service.active ? deactivateServiceAction : reactivateServiceAction
  const [state, action, pending] = useActionState(statusAction, initial)
  return (
    <form action={action} className="space-y-4">
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      {state.done && (
        <Alert>
          <AlertDescription>Status layanan diperbarui.</AlertDescription>
        </Alert>
      )}
      <input type="hidden" name="id" value={service.id} />
      <Button type="submit" variant={service.active ? 'destructive' : 'default'} disabled={pending}>
        {pending
          ? 'Memproses…'
          : service.active ? 'Nonaktifkan layanan' : 'Aktifkan layanan'}
      </Button>
    </form>
  )
}
