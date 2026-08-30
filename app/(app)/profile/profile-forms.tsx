'use client'

import { useActionState } from 'react'
import { updateProfileAction, changePasswordAction, revokeSessionAction } from './actions'
import type { FormState } from '@/lib/form-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'

const initial: FormState = {}

export function ProfileNameForm({ name }: { name: string }) {
  const [state, action, pending] = useActionState(updateProfileAction, initial)
  return (
    <form action={action} className="space-y-4">
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      {state.done && (
        <Alert>
          <AlertDescription>Tersimpan.</AlertDescription>
        </Alert>
      )}
      <div className="space-y-2">
        <Label htmlFor="name">Nama</Label>
        <Input id="name" name="name" defaultValue={name} required />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? 'Menyimpan…' : 'Simpan'}
      </Button>
    </form>
  )
}

export function ChangePasswordForm() {
  const [state, action, pending] = useActionState(changePasswordAction, initial)
  return (
    <form action={action} className="space-y-4">
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      {state.done && (
        <Alert>
          <AlertDescription>Kata sandi diperbarui.</AlertDescription>
        </Alert>
      )}
      <div className="space-y-2">
        <Label htmlFor="current">Kata sandi saat ini</Label>
        <Input id="current" name="current" type="password" required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="next">Kata sandi baru</Label>
        <Input id="next" name="next" type="password" minLength={8} required />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? 'Menyimpan…' : 'Ubah kata sandi'}
      </Button>
    </form>
  )
}

export function RevokeSessionForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(revokeSessionAction, initial)
  return (
    <form action={action} className="space-y-2">
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      <input type="hidden" name="token" value={token} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? 'Mencabut…' : 'Cabut'}
      </Button>
    </form>
  )
}
