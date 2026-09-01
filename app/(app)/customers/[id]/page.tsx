import { notFound } from 'next/navigation'
import { requirePageOrg, requirePagePermission } from '@/lib/session'
import { getCustomer } from '@/lib/customer'
import { CustomerDetailForm, CustomerStatusForm } from './customer-detail-forms'
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card'

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  await requirePagePermission({ customer: ['update'] })
  const { organizationId } = await requirePageOrg()
  const { id } = await params
  // Scoped by organizationId in the query, so another salon's id is a 404
  // rather than a leak.
  const customer = await getCustomer(id, organizationId)
  if (!customer) notFound()

  return (
    <div className="max-w-lg space-y-6">
      <h1 className="text-xl font-medium">{customer.name}</h1>

      <Card>
        <CardHeader><CardTitle>Detail</CardTitle></CardHeader>
        <CardContent>
          <CustomerDetailForm customer={{
            id: customer.id,
            name: customer.name,
            phone: customer.phone,
            notes: customer.notes,
          }} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Status</CardTitle>
          <CardDescription>
            Pelanggan nonaktif tetap tersimpan beserta riwayatnya.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CustomerStatusForm customer={{ id: customer.id, active: customer.active }} />
        </CardContent>
      </Card>
    </div>
  )
}
