import Link from 'next/link'
import { requirePagePermission, requirePageOrg } from '@/lib/session'
import { listServices, salonCurrency, type ServiceRow } from '@/lib/service'
import { getEntitlements, countResource } from '@/lib/plan/entitlements'
import { formatMoney } from '@/lib/money'
import { buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { CategoryCreateForm } from './category-form'

const UNCATEGORISED = 'Tanpa kategori'

export default async function ServicesPage() {
  // §5.1: this reads with service:['update'], not ['read'] -- front desk and
  // stylists hold ['read'] too, and catalogue management is not their
  // screen (reading a price belongs to POS and booking instead).
  await requirePagePermission({ service: ['update'] })
  const { organizationId } = await requirePageOrg()

  const [services, entitlements, used, currency] = await Promise.all([
    listServices(organizationId),
    getEntitlements(organizationId),
    countResource(organizationId, 'services'),
    salonCurrency(organizationId),
  ])
  const cap = entitlements.caps.services

  // listServices already orders by category name (nulls last), so grouping
  // into a Map in that same order needs no re-sort here.
  const groups = new Map<string, ServiceRow[]>()
  for (const s of services) {
    const key = s.categoryName ?? UNCATEGORISED
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(s)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-medium">Layanan</h1>
          {cap !== undefined && used !== null && (
            <p className="text-sm text-muted-foreground">
              {used} dari {cap} layanan terpakai
            </p>
          )}
        </div>
        <Link href="/dashboard/services/new" className={buttonVariants()}>
          Tambah layanan
        </Link>
      </div>

      <CategoryCreateForm />

      {groups.size === 0 ? (
        <p className="text-sm text-muted-foreground">Belum ada layanan.</p>
      ) : (
        [...groups.entries()].map(([category, rows]) => (
          <div key={category} className="space-y-2">
            <h2 className="text-sm font-medium text-muted-foreground">{category}</h2>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nama</TableHead>
                  <TableHead>Durasi</TableHead>
                  <TableHead>Harga</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">{s.name}</TableCell>
                    <TableCell>{s.durationMinutes} menit</TableCell>
                    <TableCell>{formatMoney(s.price, currency)}</TableCell>
                    <TableCell>
                      <Badge variant={s.active ? 'default' : 'secondary'}>
                        {s.active ? 'Aktif' : 'Nonaktif'}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ))
      )}
    </div>
  )
}
