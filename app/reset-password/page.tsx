'use client'

import { Suspense, useActionState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { resetPasswordAction } from '../(auth)/actions'
import type { FormState } from '@/lib/form-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card'

const initial: FormState = {}

function ResetPasswordForm() {
  const token = useSearchParams().get('token') ?? ''
  const [state, action, pending] = useActionState(resetPasswordAction, initial)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Atur ulang kata sandi</CardTitle>
        <CardDescription>Masukkan kata sandi baru Anda.</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="space-y-4">
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <input type="hidden" name="token" value={token} />
          <div className="space-y-2">
            <Label htmlFor="password">Kata sandi baru</Label>
            <Input
              id="password" name="password" type="password"
              autoComplete="new-password" minLength={8} required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm">Konfirmasi kata sandi</Label>
            <Input
              id="confirm" name="confirm" type="password"
              autoComplete="new-password" minLength={8} required
            />
          </div>
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? 'Memproses…' : 'Atur ulang kata sandi'}
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            <Link href="/login" className="underline">Kembali ke halaman masuk</Link>
          </p>
        </form>
      </CardContent>
    </Card>
  )
}

/**
 * Deliberately OUTSIDE the (auth) group: that layout bounces anyone with a
 * session to /dashboard, which would lock out a user who is still signed in
 * on another device and clicks their reset link. Everything else in (auth) is
 * meaningless when signed in; this page is not, so it carries its own copy of
 * the centered-card shell instead.
 */
export default function ResetPasswordPage() {
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <Suspense>
          <ResetPasswordForm />
        </Suspense>
      </div>
    </div>
  )
}
