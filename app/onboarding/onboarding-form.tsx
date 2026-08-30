'use client'

import { useActionState } from 'react'
import { createSalonAction } from './actions'
import type { FormState } from '@/lib/form-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card'

const initial: FormState = {}

export function OnboardingForm() {
  const [state, action, pending] = useActionState(createSalonAction, initial)
  return (
    <Card>
      <CardHeader>
        <CardTitle>Buat salon Anda</CardTitle>
        <CardDescription>Satu langkah lagi sebelum Anda mulai.</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="space-y-4">
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-2">
            <Label htmlFor="name">Nama salon</Label>
            <Input id="name" name="name" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="slug">Slug</Label>
            <Input id="slug" name="slug" pattern="[a-z0-9\-]+" required />
          </div>
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? 'Memproses…' : 'Buat salon'}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
