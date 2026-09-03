'use client'

import { useActionState } from 'react'
import { closeShiftAction, voidSaleAction } from '../pos/actions'
import type { FormState } from '@/lib/form-state'
import { Button } from '@/components/ui/button'

const initial: FormState = {}

/** Only rendered for someone holding pos:['void'] -- the action re-checks, so
 *  this decides what is drawn, never what is allowed. */
export function VoidButton({ id }: { id: string }) {
  const [state, action, pending] = useActionState(voidSaleAction, initial)
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="id" value={id} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? 'Membatalkan…' : 'Batalkan'}
      </Button>
      {state.error && <span className="text-sm text-destructive">{state.error}</span>}
    </form>
  )
}

export function CloseShiftButton({ id }: { id: string }) {
  const [state, action, pending] = useActionState(closeShiftAction, initial)
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="id" value={id} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? 'Menutup…' : 'Tutup shift'}
      </Button>
      {state.error && <span className="text-sm text-destructive">{state.error}</span>}
    </form>
  )
}
