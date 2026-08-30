import { requirePagePermission } from '@/lib/session'
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card'
import { BranchCreateForm } from './branch-create-form'

export default async function NewBranchPage() {
  await requirePagePermission({ branch: ['create'] })

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
          <BranchCreateForm />
        </CardContent>
      </Card>
    </div>
  )
}
