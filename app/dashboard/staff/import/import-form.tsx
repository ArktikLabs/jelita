'use client'

import { useActionState } from 'react'
import { importStaffAction } from '../actions'
import type { ImportState } from '@/lib/form-state'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'

const initial: ImportState = {}

const PLACEHOLDER = `Nama,email,kata sandi,peran,cabang
Siti Aminah,siti@contoh.local,demosandi1,stylist,Cabang Utama
Budi Santoso,budi@contoh.local,demosandi1,admin,`

export function ImportStaffForm() {
  const [state, action, pending] = useActionState(importStaffAction, initial)

  return (
    <form action={action} className="space-y-4">
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>
            <p>{state.error}</p>
            {state.rows && state.rows.length > 0 && (
              <ul className="mt-2 list-disc space-y-1 pl-4">
                {state.rows.map((r) => (
                  <li key={r.line}>{`Baris ${r.line}: ${r.message}`}</li>
                ))}
              </ul>
            )}
          </AlertDescription>
        </Alert>
      )}
      <div className="space-y-2">
        <Label htmlFor="csv">Data staf (CSV)</Label>
        {/* No shadcn Textarea in this project yet -- styled to match Input. */}
        <textarea
          id="csv"
          name="csv"
          required
          rows={10}
          placeholder={PLACEHOLDER}
          className="w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
        />
        <p className="text-xs text-muted-foreground">
          Satu baris per staf: nama, email, kata sandi (minimal 8 karakter), peran
          (admin/stylist/frontdesk), nama cabang. Kosongkan cabang untuk admin;
          wajib diisi untuk stylist dan frontdesk.
        </p>
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? 'Mengimpor…' : 'Impor'}
      </Button>
    </form>
  )
}
