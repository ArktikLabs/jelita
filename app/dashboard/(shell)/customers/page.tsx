import { Suspense } from 'react'
import Link from 'next/link'
import { requirePageOrg, requirePagePermission } from '@/lib/session'
import { CUSTOMER_LIST, listCustomers } from '@/lib/customer'
import { parseListQuery } from '@/lib/list-query'
import { clearFilters, listHref, preservedFields, type Params } from '@/lib/list-url'
import { buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { SortableHead } from '@/components/list/sortable-head'
import { FilterBar } from '@/components/list/filter-bar'
import { Pagination } from '@/components/list/pagination'
import { SelectAll, SelectionBar, SelectionProvider, SelectRow } from '@/components/list-selection'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'

/**
 * Task 5 wires this into `lib/bulk.ts`'s `bulkDeactivate` and the guard
 * reporting it needs. For now it is only the seam `SelectionBar`'s interface
 * requires -- a Server Action passed as a prop, not a URL string.
 */
async function deactivateSelectedCustomers(_formData: FormData) {
  'use server'
}

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<Params>
}) {
  // read, not update: front desk needs the list at checkout, and stylists may
  // look someone up. The create and edit screens guard more tightly.
  await requirePagePermission({ customer: ['read'] })
  const { organizationId } = await requirePageOrg()
  const params = await searchParams
  const query = parseListQuery(CUSTOMER_LIST, params)
  const customers = await listCustomers(organizationId, query)
  const q = query.q

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-medium">Pelanggan</h1>
        <div className="flex items-center gap-2">
          {/* The export must carry the CURRENT view, so it reuses the same
              searchParams the list was built from -- a bare /csv link would
              silently export the unfiltered table, which is the bug §8
              exists to prevent. */}
          <a
            href={`/api/customers/csv?${new URLSearchParams(
              Object.entries(params).filter(([, v]) => typeof v === 'string') as [string, string][],
            )}`}
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            Ekspor CSV
          </a>
          <Link href="/dashboard/customers/new" className={buttonVariants()}>
            Tambah pelanggan
          </Link>
        </div>
      </div>

      {/* A plain GET form: zero client JS, and the query survives a reload.
          A native GET submit replaces the WHOLE query string with only this
          form's own named inputs, so it can't go through listHref like every
          other control -- preservedFields is what stops it from silently
          dropping whatever it doesn't ask for by name (sort, active, per...). */}
      <form className="max-w-sm">
        {preservedFields(params, ['q']).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <Input name="q" defaultValue={q ?? ''} placeholder="Cari nama atau nomor" />
      </form>

      <FilterBar spec={CUSTOMER_LIST} query={query} params={params} />

      <SelectionProvider total={customers.total}>
        {/* SelectionBar reads the current filter via useSearchParams, which
            requires a Suspense boundary -- see app/reset-password/page.tsx
            for the same pattern. */}
        <Suspense>
          <SelectionBar action={deactivateSelectedCustomers} label="Nonaktifkan yang dipilih" />
        </Suspense>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <SelectAll ids={customers.rows.map((c) => c.id)} />
              </TableHead>
              <SortableHead column="name" label="Nama" spec={CUSTOMER_LIST} query={query} params={params} />
              <TableHead>Nomor</TableHead>
              <TableHead>Status</TableHead>
              <SortableHead column="created" label="Dibuat" spec={CUSTOMER_LIST} query={query} params={params} />
            </TableRow>
          </TableHeader>
          <TableBody>
            {customers.rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">
                  {query.q || Object.keys(query.filters).length > 0 ? (
                    <>
                      Tidak ada pelanggan yang cocok dengan pencarian ini.{' '}
                      <Link href={listHref(params, clearFilters(CUSTOMER_LIST))} className="underline">
                        Hapus filter
                      </Link>
                    </>
                  ) : (
                    'Belum ada pelanggan.'
                  )}
                </TableCell>
              </TableRow>
            )}
            {customers.rows.map((c) => (
              <TableRow key={c.id}>
                <TableCell>
                  <SelectRow id={c.id} />
                </TableCell>
                <TableCell>
                  <Link href={`/dashboard/customers/${c.id}`} className="underline">{c.name}</Link>
                </TableCell>
                <TableCell>{c.phone ?? '—'}</TableCell>
                <TableCell>
                  <Badge variant={c.active ? 'secondary' : 'outline'}>
                    {c.active ? 'Aktif' : 'Nonaktif'}
                  </Badge>
                </TableCell>
                <TableCell>{c.createdAt}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </SelectionProvider>

      <Pagination result={customers} params={params} />
    </div>
  )
}
