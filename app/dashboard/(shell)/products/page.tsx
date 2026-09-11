import { headers } from 'next/headers'
import Link from 'next/link'
import { requireBranch, requirePagePermission, requirePageOrg } from '@/lib/session'
import { auth } from '@/lib/auth'
import { PRODUCT_LIST, listProducts, productsOf } from '@/lib/inventory'
import { salonSettings } from '@/lib/service'
import { formatMoney, type CurrencyCode } from '@/lib/money'
import { parseListQuery, wasTruncated } from '@/lib/list-query'
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
import { ProductCreateForm, StockAdjustForm } from './product-forms'

/**
 * PRD §5.4. Stock is per branch (§5.8), so this shows the ACTIVE branch's
 * on-hand -- switching branches switches the numbers, and nothing here is
 * salon-wide except the products themselves.
 */
export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<Params>
}) {
  await requirePagePermission({ product: ['read'] })
  const { organizationId } = await requirePageOrg()
  const { branchId } = await requireBranch()
  const params = await searchParams
  const query = parseListQuery(PRODUCT_LIST, params)

  // `all` is EVERY product of this branch, unpaged -- the low-stock banner
  // and the stock-adjust form's dropdown must cover the whole shelf, not
  // just whatever page happens to be showing.
  const [page, all, { currency }] = await Promise.all([
    listProducts(organizationId, branchId, query),
    productsOf(organizationId, branchId),
    salonSettings(organizationId),
  ])
  // stock:['adjust'] is a separate statement from product:['read'] -- front
  // desk can see what is on the shelf without being able to rewrite it.
  const { success: canAdjust } = await auth.api.hasPermission({
    headers: await headers(),
    body: { permissions: { stock: ['adjust'] } },
  })
  const { success: canCreate } = await auth.api.hasPermission({
    headers: await headers(),
    body: { permissions: { product: ['create'] } },
  })

  const low = all.filter((p) => p.active && p.low)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-medium">Produk</h1>
        {/* The export must carry the CURRENT view, so it reuses the same
            searchParams the list was built from -- a bare /csv link would
            silently export the unfiltered table. */}
        <a
          href={`/api/products/csv?${new URLSearchParams(
            Object.entries(params).filter(([, v]) => typeof v === 'string') as [string, string][],
          )}`}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          Ekspor CSV
        </a>
      </div>

      {/* §8: the CSV export caps at 10.000 rows and says so IN THE FILE
          (lib/list-csv.ts) -- this is the same warning on the SCREEN. */}
      {wasTruncated(page.total) && (
        <p className="text-sm text-muted-foreground">
          Ekspor CSV akan dipotong pada 10.000 baris dari {page.total} produk yang cocok.
          Persempit filter untuk mengekspor sisanya.
        </p>
      )}

      {low.length > 0 && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          Stok menipis: {low.map((p) => `${p.name} (${p.onHand})`).join(', ')}
        </div>
      )}

      <form className="max-w-sm">
        {preservedFields(params, ['q']).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <Input name="q" defaultValue={query.q ?? ''} placeholder="Cari nama produk" />
      </form>

      <FilterBar spec={PRODUCT_LIST} query={query} params={params} />

      <Table>
        <TableHeader>
          <TableRow>
            <SortableHead column="name" label="Nama" spec={PRODUCT_LIST} query={query} params={params} />
            <SortableHead column="sku" label="SKU" spec={PRODUCT_LIST} query={query} params={params} />
            <TableHead>Jenis</TableHead>
            <SortableHead column="price" label="Harga" spec={PRODUCT_LIST} query={query} params={params} />
            <TableHead>Stok</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {page.rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="text-muted-foreground">
                {query.q || Object.keys(query.filters).length > 0 ? (
                  <>
                    Tidak ada produk yang cocok dengan pencarian ini.{' '}
                    <Link href={listHref(params, clearFilters(PRODUCT_LIST))} className="underline">
                      Hapus filter
                    </Link>
                  </>
                ) : (
                  'Belum ada produk.'
                )}
              </TableCell>
            </TableRow>
          )}
          {page.rows.map((p) => (
            <TableRow key={p.id}>
              <TableCell className="font-medium">{p.name}</TableCell>
              <TableCell>{p.sku ?? '—'}</TableCell>
              <TableCell>{p.kind === 'retail' ? 'Ritel' : 'Internal'}</TableCell>
              <TableCell>
                {p.price === null ? '—' : formatMoney(p.price, currency as CurrencyCode)}
              </TableCell>
              <TableCell data-testid={`stock-${p.id}`}>
                {p.onHand}
                {p.low && p.active && (
                  <Badge variant="destructive" className="ml-2">Menipis</Badge>
                )}
              </TableCell>
              <TableCell>
                <Badge variant={p.active ? 'default' : 'secondary'}>
                  {p.active ? 'Aktif' : 'Nonaktif'}
                </Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Pagination result={page} params={params} />

      {canCreate && <ProductCreateForm />}
      {canAdjust && all.length > 0 && (
        <StockAdjustForm products={all.map((p) => ({ id: p.id, name: p.name }))} />
      )}
    </div>
  )
}
