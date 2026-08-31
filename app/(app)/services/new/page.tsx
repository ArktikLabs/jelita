import { requirePagePermission, requirePageOrg } from '@/lib/session'
import { listCategories, salonCurrency } from '@/lib/service'
import {
  Card, CardContent, CardHeader, CardTitle,
} from '@/components/ui/card'
import { ServiceCreateForm } from './service-form'

export default async function NewServicePage() {
  await requirePagePermission({ service: ['create'] })
  const { organizationId } = await requirePageOrg()
  const [categories, currency] = await Promise.all([
    listCategories(organizationId),
    salonCurrency(organizationId),
  ])

  return (
    <div className="mx-auto max-w-lg">
      <Card>
        <CardHeader>
          <CardTitle>Tambah layanan</CardTitle>
        </CardHeader>
        <CardContent>
          <ServiceCreateForm categories={categories} currency={currency} />
        </CardContent>
      </Card>
    </div>
  )
}
