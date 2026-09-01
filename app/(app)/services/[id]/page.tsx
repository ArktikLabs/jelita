import { notFound } from 'next/navigation'
import { requirePagePermission, requirePageOrg } from '@/lib/session'
import { getService, listCategories, salonCurrency } from '@/lib/service'
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ServiceDetailForm, OverridesForm, ServiceStatusForm } from './service-detail-forms'

export default async function ServiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  // §5.1: same guard as /services -- catalogue management, not the read-only
  // view front desk/stylists hold.
  await requirePagePermission({ service: ['update'] })
  const { organizationId } = await requirePageOrg()
  const { id } = await params

  // getService is org-scoped in the query itself, so null here covers both
  // "no such service" and "not yours" -- notFound() is correct for both.
  const result = await getService(id, organizationId)
  if (!result) notFound()
  const { service, overrides } = result

  const [categories, currency] = await Promise.all([
    listCategories(organizationId),
    salonCurrency(organizationId),
  ])

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{service.name}</CardTitle>
          <CardDescription>
            {service.categoryName ?? 'Tanpa kategori'} · {service.durationMinutes} menit
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Badge variant={service.active ? 'default' : 'secondary'}>
            {service.active ? 'Aktif' : 'Nonaktif'}
          </Badge>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Detail layanan</CardTitle>
          <CardDescription>Ubah nama, kategori, durasi, dan harga salon.</CardDescription>
        </CardHeader>
        <CardContent>
          <ServiceDetailForm
            service={{
              id: service.id,
              name: service.name,
              categoryId: service.categoryId,
              durationMinutes: service.durationMinutes,
              price: service.price,
            }}
            categories={categories}
            currency={currency}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Harga per cabang</CardTitle>
          <CardDescription>
            Kosongkan harga agar cabang mengikuti harga salon. Isi untuk menetapkan
            harga khusus di cabang itu, meski nilainya sama dengan harga salon.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <OverridesForm
            serviceId={service.id}
            currency={currency}
            salonPrice={service.price}
            overrides={overrides}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Status</CardTitle>
          <CardDescription>
            {service.active
              ? 'Menonaktifkan layanan menyembunyikannya dari pemesanan di semua cabang.'
              : 'Mengaktifkan kembali layanan ini memakai satu kuota layanan paket.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ServiceStatusForm service={{ id: service.id, active: service.active }} />
        </CardContent>
      </Card>
    </div>
  )
}
