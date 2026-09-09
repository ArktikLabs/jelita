import Link from 'next/link'
import { requirePagePermission, requirePageOrg } from '@/lib/session'
import { SERVICE_LIST, listServices, salonCurrency } from '@/lib/service'
import { getEntitlements, countResource } from '@/lib/plan/entitlements'
import { formatMoney } from '@/lib/money'
import { parseListQuery } from '@/lib/list-query'
import { clearFilters, listHref, preservedFields, type Params } from '@/lib/list-url'
import { buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { SortableHead } from '@/components/list/sortable-head'
import { FilterBar } from '@/components/list/filter-bar'
import { Pagination } from '@/components/list/pagination'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { CategoryCreateForm } from './category-form'

const UNCATEGORISED = 'Tanpa kategori'

export default async function ServicesPage({
  searchParams,
}: {
  searchParams: Promise<Params>
}) {
  // §5.1: this reads with service:['update'], not ['read'] -- front desk and
  // stylists hold ['read'] too, and catalogue management is not their
  // screen (reading a price belongs to POS and booking instead).
  await requirePagePermission({ service: ['update'] })
  const { organizationId } = await requirePageOrg()
  const params = await searchParams
  const query = parseListQuery(SERVICE_LIST, params)

  const [services, entitlements, used, currency] = await Promise.all([
    listServices(organizationId, query),
    getEntitlements(organizationId),
    countResource(organizationId, 'services'),
    salonCurrency(organizationId),
  ])
  const cap = entitlements.caps.services

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

      <form className="max-w-sm">
        {preservedFields(params, ['q']).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <Input name="q" defaultValue={query.q ?? ''} placeholder="Cari nama layanan" />
      </form>

      <FilterBar spec={SERVICE_LIST} query={query} params={params} />

      <Table>
        <TableHeader>
          <TableRow>
            <SortableHead column="name" label="Nama" spec={SERVICE_LIST} query={query} params={params} />
            <TableHead>Kategori</TableHead>
            <TableHead>Durasi</TableHead>
            <SortableHead column="price" label="Harga" spec={SERVICE_LIST} query={query} params={params} />
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {services.rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="text-muted-foreground">
                {query.q || Object.keys(query.filters).length > 0 ? (
                  <>
                    Tidak ada layanan yang cocok dengan pencarian ini.{' '}
                    <Link href={listHref(params, clearFilters(SERVICE_LIST))} className="underline">
                      Hapus filter
                    </Link>
                  </>
                ) : (
                  'Belum ada layanan.'
                )}
              </TableCell>
            </TableRow>
          )}
          {services.rows.map((s) => (
            <TableRow key={s.id}>
              <TableCell className="font-medium">{s.name}</TableCell>
              <TableCell>{s.categoryName ?? UNCATEGORISED}</TableCell>
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

      <Pagination result={services} params={params} />
    </div>
  )
}
