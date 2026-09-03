'use client'

import { useActionState } from 'react'
import { setBaseSalaryAction } from '../payroll/actions'
import type { FormState } from '@/lib/form-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'

const initial: FormState = {}

/**
 * Empty CLEARS the salary rather than storing zero: "not salaried" and
 * "salaried at nothing" are different statements, and commission-only staff
 * are the normal case (spec 2.1).
 */
export function BaseSalaryForm({
  userId, baseSalary,
}: {
  userId: string
  baseSalary: string
}) {
  const [state, action, pending] = useActionState(setBaseSalaryAction, initial)

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="userId" value={userId} />
      {state.error && (
        <Alert variant="destructive"><AlertDescription>{state.error}</AlertDescription></Alert>
      )}
      {state.done && <Alert><AlertDescription>Gaji pokok disimpan.</AlertDescription></Alert>}
      <div className="space-y-2">
        <Label htmlFor="baseSalary">Gaji pokok per bulan</Label>
        <Input id="baseSalary" name="baseSalary" defaultValue={baseSalary} />
        <p className="text-xs text-muted-foreground">
          Kosongkan kalau staf ini hanya dapat komisi.
        </p>
      </div>
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? 'Menyimpan…' : 'Simpan gaji pokok'}
      </Button>
    </form>
  )
}
