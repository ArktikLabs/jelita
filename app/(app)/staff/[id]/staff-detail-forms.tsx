'use client'

import { useActionState, useState } from 'react'
import { updateStaffRoleAction, transferStaffAction } from '../actions'
import type { FormState } from '@/lib/form-state'
import type { StaffRow } from '@/lib/staff'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'

const initial: FormState = {}

// Mirrors actions.ts's NEEDS_BRANCH -- duplicated, not imported, since that
// file is 'use server' and only its async actions can cross into a client
// component.
const NEEDS_BRANCH = ['stylist', 'frontdesk']

const ROLE_OPTIONS = [
  { value: 'admin', label: 'Admin' },
  { value: 'frontdesk', label: 'Front desk' },
  { value: 'stylist', label: 'Terapis' },
]

type Branch = { teamId: string; name: string }

export function RoleForm({ staff, branches }: { staff: StaffRow; branches: Branch[] }) {
  const [state, action, pending] = useActionState(updateStaffRoleAction, initial)
  const [role, setRole] = useState(staff.role)
  const [teamId, setTeamId] = useState(staff.teamId ?? '')

  return (
    <form action={action} className="space-y-4">
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      {state.done && (
        <Alert>
          <AlertDescription>Peran diperbarui.</AlertDescription>
        </Alert>
      )}
      <input type="hidden" name="userId" value={staff.userId} />
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
          <Label htmlFor="roleTeamId">Cabang</Label>
          <Select name="teamId" value={teamId} onValueChange={(v) => setTeamId(v ?? '')} required>
            <SelectTrigger id="roleTeamId" className="w-full">
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
        {pending ? 'Menyimpan…' : 'Simpan peran'}
      </Button>
    </form>
  )
}

export function TransferForm({ staff, branches }: { staff: StaffRow; branches: Branch[] }) {
  const [state, action, pending] = useActionState(transferStaffAction, initial)
  const [teamId, setTeamId] = useState(staff.teamId ?? '')

  return (
    <form action={action} className="space-y-4">
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      {state.done && (
        <Alert>
          <AlertDescription>Staf dipindahkan.</AlertDescription>
        </Alert>
      )}
      <input type="hidden" name="userId" value={staff.userId} />
      <div className="space-y-2">
        <Label htmlFor="transferTeamId">Cabang tujuan</Label>
        <Select name="teamId" value={teamId} onValueChange={(v) => setTeamId(v ?? '')} required>
          <SelectTrigger id="transferTeamId" className="w-full">
            <SelectValue placeholder="Pilih cabang" />
          </SelectTrigger>
          <SelectContent>
            {branches.map((b) => (
              <SelectItem key={b.teamId} value={b.teamId}>{b.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? 'Memindahkan…' : 'Pindahkan'}
      </Button>
    </form>
  )
}
