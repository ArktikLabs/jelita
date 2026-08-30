'use client'

import { useActionState } from 'react'
import Link from 'next/link'
import { registerAction } from '../actions'
import type { FormState } from '@/lib/form-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card'

const initial: FormState = {}

export default function RegisterPage() {
  const [state, action, pending] = useActionState(registerAction, initial)

  if (state.done) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Cek email Anda</CardTitle>
          <CardDescription>
            Kami mengirim tautan verifikasi. Klik tautan itu untuk mengaktifkan
            akun Anda.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Buat akun</CardTitle>
        <CardDescription>Mulai kelola salon Anda.</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="space-y-4">
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-2">
            <Label htmlFor="name">Nama</Label>
            <Input id="name" name="name" autoComplete="name" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Kata sandi</Label>
            <Input
              id="password" name="password" type="password"
              autoComplete="new-password" minLength={8} required
            />
          </div>
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? 'Memproses…' : 'Daftar'}
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            Sudah punya akun? <Link href="/login" className="underline">Masuk</Link>
          </p>
        </form>
      </CardContent>
    </Card>
  )
}
