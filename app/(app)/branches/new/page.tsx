import { requirePagePermission, requirePageOrg } from '@/lib/session'
import { PlanError, requireQuota } from '@/lib/plan/entitlements'
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { BranchCreateForm } from './branch-create-form'

export default async function NewBranchPage() {
  await requirePagePermission({ branch: ['create'] })
  const { organizationId } = await requirePageOrg()

  // Spec §8: `branch: ['create']` + requireQuota('branches'). The seeded free
  // cap is 1, so this is the common path, not the edge — without the quota half
  // every free-tier owner sees the button, fills three fields and only learns
  // they need to upgrade on submit. Caught rather than thrown: a page has no
  // status code to return, and 402 is news to render, not an error boundary.
  let overQuota = false
  try {
    await requireQuota('branches', organizationId)
  } catch (e) {
    if (!(e instanceof PlanError)) throw e
    overQuota = true
  }

  return (
    <div className="mx-auto max-w-lg">
      <Card>
        <CardHeader>
          <CardTitle>Tambah cabang</CardTitle>
          <CardDescription>
            Jam operasional dapat diatur setelah cabang dibuat.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {overQuota ? (
            <Alert variant="destructive">
              <AlertDescription>
                Batas cabang paket Anda sudah tercapai. Upgrade untuk menambah cabang.
              </AlertDescription>
            </Alert>
          ) : (
            <BranchCreateForm />
          )}
        </CardContent>
      </Card>
    </div>
  )
}
