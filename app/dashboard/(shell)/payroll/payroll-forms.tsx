'use client'

import { useActionState } from 'react'
import { addDeductionAction, removeDeductionAction } from './actions'
import type { FormState } from '@/lib/form-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'

const initial: FormState = {}
const inputClass = 'flex h-9 rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs'

export function DeductionForm({
  month, staff,
}: {
  month: string
  staff: { userId: string; name: string }[]
}) {
  const [state, action, pending] = useActionState(addDeductionAction, initial)

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="month" value={month} />
      {state.error && (
        <Alert variant="destructive"><AlertDescription>{state.error}</AlertDescription></Alert>
      )}
      {state.done && <Alert><AlertDescription>Potongan disimpan.</AlertDescription></Alert>}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="userId">Staf</Label>
          <select id="userId" name="userId" required className={`${inputClass} w-full`}>
            {staff.map((s) => (
              <option key={s.userId} value={s.userId}>{s.name}</option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="amount">Jumlah</Label>
          <Input id="amount" name="amount" required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="note">Keterangan</Label>
          <Input id="note" name="note" placeholder="mis. seragam" />
        </div>
      </div>
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? 'Menyimpan…' : 'Tambah potongan'}
      </Button>
    </form>
  )
}

export function RemoveDeductionButton({ id }: { id: string }) {
  const [state, action, pending] = useActionState(removeDeductionAction, initial)
  return (
    <form action={action} className="inline">
      <input type="hidden" name="id" value={id} />
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>Hapus</Button>
      {state.error && <span className="text-sm text-destructive">{state.error}</span>}
    </form>
  )
}
