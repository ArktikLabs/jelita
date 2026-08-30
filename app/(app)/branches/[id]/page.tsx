import { notFound } from 'next/navigation'
import { requirePagePermission, requirePageOrg } from '@/lib/session'
import { getBranch } from '@/lib/branch'
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

  // getBranch is scoped by organizationId in the query itself, so null here
  // covers both "no such branch" and "not yours" — notFound() is correct for both.
  const data = await getBranch(id, organizationId)
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
          <BranchDetailsForm profile={profile} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Jam operasional</CardTitle>
          <CardDescription>Atur jam buka dan tutup per hari.</CardDescription>
        </CardHeader>
        <CardContent>
          <BranchHoursForm teamId={profile.teamId} hours={hours} />
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
