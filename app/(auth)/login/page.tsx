'use client'

import { useActionState } from 'react'
import Link from 'next/link'
import { loginAction } from '../actions'
import type { FormState } from '@/lib/form-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card'

const initial: FormState = {}

export default function LoginPage() {
  const [state, action, pending] = useActionState(loginAction, initial)
  return (
    <Card>
      <CardHeader>
        <CardTitle>Masuk</CardTitle>
        <CardDescription>Kelola salon Anda.</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="space-y-4">
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Kata sandi</Label>
            <Input id="password" name="password" type="password" required />
          </div>
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? 'Memproses…' : 'Masuk'}
          </Button>
          <div className="flex justify-between text-sm">
            <Link href="/forgot-password" className="underline">
              Lupa kata sandi?
            </Link>
            <Link href="/register" className="underline">Daftar</Link>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
