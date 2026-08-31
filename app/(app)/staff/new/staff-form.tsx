'use client'

import { useActionState, useState } from 'react'
import { createStaffAction } from '../actions'
import type { FormState } from '@/lib/form-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'

const initial: FormState = {}

// Mirrors actions.ts's NEEDS_BRANCH — duplicated, not imported, since that
// file is 'use server' and only its async actions can cross into a client
// component.
const NEEDS_BRANCH = ['stylist', 'frontdesk']

const ROLE_OPTIONS = [
  { value: 'admin', label: 'Admin' },
  { value: 'frontdesk', label: 'Front desk' },
  { value: 'stylist', label: 'Terapis' },
]

export function StaffCreateForm({
  branches,
}: {
  branches: { teamId: string; name: string }[]
}) {
  const [state, action, pending] = useActionState(createStaffAction, initial)
  const [role, setRole] = useState('')

  return (
    <form action={action} className="space-y-4">
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      <div className="space-y-2">
        <Label htmlFor="name">Nama</Label>
        <Input id="name" name="name" required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">Kata sandi</Label>
        <Input id="password" name="password" type="password" required minLength={8} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="role">Peran</Label>
        <Select name="role" value={role} onValueChange={(v) => setRole(v ?? '')} required>
          <SelectTrigger id="role" className="w-full">
            <SelectValue placeholder="Pilih peran" />
          </SelectTrigger>
          <SelectContent>
            {ROLE_OPTIONS.map((r) => (
              <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {NEEDS_BRANCH.includes(role) && (
        <div className="space-y-2">
          <Label htmlFor="teamId">Cabang</Label>
          <Select name="teamId" required>
            <SelectTrigger id="teamId" className="w-full">
              <SelectValue placeholder="Pilih cabang" />
            </SelectTrigger>
            <SelectContent>
              {branches.map((b) => (
                <SelectItem key={b.teamId} value={b.teamId}>{b.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <Button type="submit" disabled={pending}>
        {pending ? 'Menyimpan…' : 'Simpan'}
      </Button>
    </form>
  )
}
