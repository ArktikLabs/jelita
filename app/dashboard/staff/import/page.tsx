import { requirePagePermission, requirePageOrg } from '@/lib/session'
import { countResource, getEntitlements } from '@/lib/plan/entitlements'
import {
  Card, CardContent, CardHeader, CardTitle,
} from '@/components/ui/card'
import { ImportStaffForm } from './import-form'

export default async function ImportStaffPage() {
  await requirePagePermission({ staff: ['create'] })
  const { organizationId } = await requirePageOrg()

  // Shown before a file is even chosen, so the seat budget is part of
  // deciding what to paste -- not a surprise after the file is validated.
  const [entitlements, used] = await Promise.all([
    getEntitlements(organizationId),
    countResource(organizationId, 'staff'),
  ])
  const cap = entitlements.caps.staff
  const remaining = cap !== undefined && used !== null ? cap - used : null

  return (
    <div className="mx-auto max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle>Impor staf</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {remaining !== null
              ? `Sisa kuota staf: ${remaining} dari ${cap}`
              : 'Sisa kuota staf: tidak terbatas'}
          </p>
          <ImportStaffForm />
        </CardContent>
      </Card>
    </div>
  )
}
