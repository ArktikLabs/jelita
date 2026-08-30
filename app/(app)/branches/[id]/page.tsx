import { notFound } from 'next/navigation'
import { requirePagePermission, requirePageOrg } from '@/lib/session'
import { listBranches, getBranch } from '@/lib/branch'
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card'
import {
  BranchDetailsForm, BranchHoursForm, BranchStatusForm,
} from './branch-detail-forms'

export default async function BranchDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  await requirePagePermission({ branch: ['update'] })
  const { organizationId } = await requirePageOrg()
  const { id } = await params

  // getBranch(id) alone does not scope by organization — confirm this team
  // belongs to the caller's org before trusting anything it returns.
  const branches = await listBranches(organizationId)
  if (!branches.some((b) => b.teamId === id)) notFound()

  const data = await getBranch(id)
  if (!data) notFound()
  const { profile, hours } = data

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{profile.name}</CardTitle>
          <CardDescription>Detail cabang.</CardDescription>
        </CardHeader>
        <CardContent>
          <BranchDetailsForm key={`details-${profile.name}`} profile={profile} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Jam operasional</CardTitle>
          <CardDescription>Atur jam buka dan tutup per hari.</CardDescription>
        </CardHeader>
        <CardContent>
          <BranchHoursForm
            key={hours.map((h) => `${h.closed}-${h.opensAt}-${h.closesAt}`).join('|')}
            teamId={profile.teamId}
            hours={hours}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Status</CardTitle>
          <CardDescription>
            {profile.active
              ? 'Nonaktifkan cabang ini jika sudah tidak beroperasi.'
              : 'Cabang ini sedang nonaktif.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <BranchStatusForm teamId={profile.teamId} active={profile.active} />
        </CardContent>
      </Card>
    </div>
  )
}
