import { notFound } from 'next/navigation'
import { requirePagePermission, requirePageOrg } from '@/lib/session'
import { getStaff } from '@/lib/staff'
import { listBranches } from '@/lib/branch'
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card'
import { RoleForm, TransferForm, StatusForm, PasswordForm } from './staff-detail-forms'

// Mirrors actions.ts's NEEDS_BRANCH -- duplicated, not imported, since that
// file is 'use server' and only its async actions can cross into this page.
const NEEDS_BRANCH = ['stylist', 'frontdesk']

export default async function StaffDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const actor = await requirePagePermission({ staff: ['read'] })
  const { organizationId } = await requirePageOrg()
  const { id } = await params

  // getStaff is scoped by organizationId in the query itself, so null here
  // covers both "no such staff" and "not yours" -- notFound() is correct for both.
  const staff = await getStaff(id, organizationId)
  if (!staff) notFound()

  const branches = await listBranches(organizationId)
  // Narrowed to what the forms need, same as /staff/new -- a full BranchRow
  // would serialize into the RSC payload for fields these forms never show.
  const branchOptions = branches.map((b) => ({ teamId: b.teamId, name: b.name }))
  // Owner and admin are salon-wide (team_id always null, spec §4) --
  // transferStaffAction refuses this server-side regardless, but the card
  // shouldn't offer an operation that can only fail.
  const canTransfer = staff.role.split(',').some((r) => NEEDS_BRANCH.includes(r))
  // Both self-only cards are hidden for the same reason the transfer card is:
  // an operation that can only ever fail, or can only hurt you, should not be
  // offered. The server refuses the deactivation regardless.
  const isSelf = staff.userId === actor.user.id

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{staff.name}</CardTitle>
          <CardDescription>{staff.email}</CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Peran</CardTitle>
          <CardDescription>Ubah peran staf ini di salon.</CardDescription>
        </CardHeader>
        <CardContent>
          <RoleForm staff={staff} branches={branchOptions} />
        </CardContent>
      </Card>

      {canTransfer && (
        <Card>
          <CardHeader>
            <CardTitle>Cabang</CardTitle>
            <CardDescription>Pindahkan staf ini ke cabang lain.</CardDescription>
          </CardHeader>
          <CardContent>
            <TransferForm staff={staff} branches={branchOptions} />
          </CardContent>
        </Card>
      )}
      {!isSelf && (
        <Card>
          <CardHeader>
            <CardTitle>Status</CardTitle>
            <CardDescription>
              {staff.active
                ? 'Menonaktifkan staf mengakhiri sesinya dan membebaskan satu kursi paket.'
                : 'Mengaktifkan kembali staf ini memakai satu kursi paket.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <StatusForm staff={staff} />
          </CardContent>
        </Card>
      )}

      {/* Hidden for self for a second reason: resetStaffPasswordAction revokes
          every session of its target, so an owner resetting their own password
          here would sign themselves out mid-click. /profile's
          changePasswordAction is the self path -- it passes
          revokeOtherSessions, keeping the caller's own session alive. */}
      {!isSelf && (
        <Card>
          <CardHeader>
            <CardTitle>Kata sandi</CardTitle>
            <CardDescription>Atur ulang kata sandi staf ini di tempat.</CardDescription>
          </CardHeader>
          <CardContent>
            <PasswordForm staff={staff} />
          </CardContent>
        </Card>
      )}
    </div>
  )
}
