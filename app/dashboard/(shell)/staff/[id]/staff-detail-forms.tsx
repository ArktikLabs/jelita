'use client'

import { useActionState, useState } from 'react'
import {
  updateStaffRoleAction, transferStaffAction,
  deactivateStaffAction, reactivateStaffAction, resetStaffPasswordAction,
} from '../actions'
import type { FormState } from '@/lib/form-state'
import type { StaffRow } from '@/lib/staff'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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

export function TransferForm({
  staff, branches, needsBranch,
}: {
  staff: StaffRow
  branches: Branch[]
  /** Stylist and front desk must always have one; owner and admin may opt
   *  back out, which is what the release button below posts. */
  needsBranch: boolean
}) {
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
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'Memindahkan…' : 'Pindahkan'}
        </Button>
        {!needsBranch && staff.teamId && (
          // A distinct field, NOT teamId="": the Select posts its own teamId
          // alongside this, and formData.get would return that one instead --
          // the release would silently re-assign the branch it meant to clear.
          <Button
            type="submit"
            name="release"
            value="1"
            variant="outline"
            disabled={pending}
          >
            Lepaskan dari cabang
          </Button>
        )}
      </div>
    </form>
  )
}

export function StatusForm({ staff }: { staff: StaffRow }) {
  const statusAction = staff.active ? deactivateStaffAction : reactivateStaffAction
  const [state, action, pending] = useActionState(statusAction, initial)
  return (
    <form action={action} className="space-y-4">
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      {state.done && (
        <Alert>
          <AlertDescription>Status staf diperbarui.</AlertDescription>
        </Alert>
      )}
      <input type="hidden" name="userId" value={staff.userId} />
      <Button type="submit" variant={staff.active ? 'destructive' : 'default'} disabled={pending}>
        {pending
          ? 'Memproses…'
          : staff.active ? 'Nonaktifkan staf' : 'Aktifkan staf'}
      </Button>
    </form>
  )
}

export function PasswordForm({ staff }: { staff: StaffRow }) {
  const [state, action, pending] = useActionState(resetStaffPasswordAction, initial)
  return (
    <form action={action} className="space-y-4">
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      {state.done && (
        <Alert>
          <AlertDescription>Kata sandi diperbarui. Sesi staf ini diakhiri.</AlertDescription>
        </Alert>
      )}
      <input type="hidden" name="userId" value={staff.userId} />
      <div className="space-y-2">
        <Label htmlFor="password">Kata sandi baru</Label>
        <Input
          id="password" name="password" type="password"
          autoComplete="new-password" minLength={8} required
        />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? 'Menyimpan…' : 'Atur ulang kata sandi'}
      </Button>
    </form>
  )
}
