'use client'

import { useActionState } from 'react'
import { createCategoryAction } from './actions'
import type { FormState } from '@/lib/form-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Alert, AlertDescription } from '@/components/ui/alert'

const initial: FormState = {}

/** Inline, on the list page itself -- a category is name-only, so a
 *  dedicated /services/categories/new screen would be one field of
 *  ceremony. */
export function CategoryCreateForm() {
  const [state, action, pending] = useActionState(createCategoryAction, initial)

  return (
    <form action={action} className="space-y-2">
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      {state.done && (
        <Alert>
          <AlertDescription>Kategori ditambahkan.</AlertDescription>
        </Alert>
      )}
      <div className="flex items-center gap-2">
        <Input name="name" placeholder="Nama kategori baru" className="max-w-64" required />
        <Button type="submit" variant="outline" size="sm" disabled={pending}>
          {pending ? 'Menyimpan…' : 'Tambah kategori'}
        </Button>
      </div>
    </form>
  )
}
