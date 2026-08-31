import { requirePagePermission, requirePageOrg } from '@/lib/session'
import { listBranches } from '@/lib/branch'
import {
  Card, CardContent, CardHeader, CardTitle,
} from '@/components/ui/card'
import { StaffCreateForm } from './staff-form'

export default async function NewStaffPage() {
  await requirePagePermission({ staff: ['create'] })
  const { organizationId } = await requirePageOrg()
  const branches = await listBranches(organizationId)

  // Narrowed to what the form needs -- {teamId, name} -- not the full
  // BranchRow. Props to a client component serialize into the RSC payload
  // whether or not they're rendered, and this form only ever shows a name.
  const branchOptions = branches.map((b) => ({ teamId: b.teamId, name: b.name }))

  return (
    <div className="mx-auto max-w-lg">
      <Card>
        <CardHeader>
          <CardTitle>Tambah staf</CardTitle>
        </CardHeader>
        <CardContent>
          <StaffCreateForm branches={branchOptions} />
        </CardContent>
      </Card>
    </div>
  )
}
