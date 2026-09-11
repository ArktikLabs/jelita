import { Suspense } from 'react'
import Link from 'next/link'
import { requirePagePermission, requirePageOrg } from '@/lib/session'
import { SERVICE_LIST, listServices, salonCurrency } from '@/lib/service'
import { getEntitlements, countResource } from '@/lib/plan/entitlements'
import { formatMoney } from '@/lib/money'
import { parseListQuery, wasTruncated } from '@/lib/list-query'
import { clearFilters, listHref, preservedFields, type Params } from '@/lib/list-url'
import { buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { SortableHead } from '@/components/list/sortable-head'
import { FilterBar } from '@/components/list/filter-bar'
import { Pagination } from '@/components/list/pagination'
import { SelectAll, SelectionBar, SelectionProvider, SelectRow } from '@/components/list-selection'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { CategoryCreateForm } from './category-form'
import { deactivateSelectedServicesAction } from './actions'

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
  const rawParams = await searchParams
  // `bulkMsg` is a one-shot flash from deactivateSelectedServicesAction's
  // redirect -- kept out of `params` so every other control on this page
  // stops carrying a stale confirmation forward once it links elsewhere.
  const { bulkMsg: bulkMsgRaw, ...params } = rawParams
  const bulkMsg = typeof bulkMsgRaw === 'string' ? bulkMsgRaw : null
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
      {bulkMsg && (
        <Alert data-testid="bulk-message" variant={bulkMsg.includes('ditolak') ? 'destructive' : 'default'}>
          <AlertDescription>{bulkMsg}</AlertDescription>
        </Alert>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-medium">Layanan</h1>
          {cap !== undefined && used !== null && (
            <p className="text-sm text-muted-foreground">
              {used} dari {cap} layanan terpakai
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* The export must carry the CURRENT view, so it reuses the same
              searchParams the list was built from. */}
          <a
            href={`/api/services/csv?${new URLSearchParams(
              Object.entries(params).filter(([, v]) => typeof v === 'string') as [string, string][],
            )}`}
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            Ekspor CSV
          </a>
          <Link href="/dashboard/services/new" className={buttonVariants()}>
            Tambah layanan
          </Link>
        </div>
      </div>

      {/* §8: the CSV export caps at 10.000 rows and says so IN THE FILE
          (lib/list-csv.ts) -- this is the same warning on the SCREEN. */}
      {wasTruncated(services.total) && (
        <p className="text-sm text-muted-foreground">
          Ekspor CSV akan dipotong pada 10.000 baris dari {services.total} layanan yang cocok.
          Persempit filter untuk mengekspor sisanya.
        </p>
      )}

      <CategoryCreateForm />

      <form className="max-w-sm">
        {preservedFields(params, ['q']).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <Input name="q" defaultValue={query.q ?? ''} placeholder="Cari nama layanan" />
      </form>

      <FilterBar spec={SERVICE_LIST} query={query} params={params} />

      {/* SelectionProvider and SelectionBar read the current filter via
          useSearchParams, which requires a Suspense boundary. */}
      <Suspense>
        <SelectionProvider total={services.total}>
          <SelectionBar action={deactivateSelectedServicesAction} label="Nonaktifkan yang dipilih" />

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <SelectAll ids={services.rows.map((s) => s.id)} />
                </TableHead>
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
                  <TableCell colSpan={6} className="text-muted-foreground">
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
                  <TableCell>
                    <SelectRow id={s.id} />
                  </TableCell>
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
        </SelectionProvider>
      </Suspense>

      <Pagination result={services} params={params} />
    </div>
  )
}
