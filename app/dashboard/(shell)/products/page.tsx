import { headers } from 'next/headers'
import { requireBranch, requirePagePermission, requirePageOrg } from '@/lib/session'
import { auth } from '@/lib/auth'
import { listProducts } from '@/lib/inventory'
import { salonSettings } from '@/lib/service'
import { formatMoney, type CurrencyCode } from '@/lib/money'
import { Badge } from '@/components/ui/badge'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { ProductCreateForm, StockAdjustForm } from './product-forms'

/**
 * PRD §5.4. Stock is per branch (§5.8), so this shows the ACTIVE branch's
 * on-hand -- switching branches switches the numbers, and nothing here is
 * salon-wide except the products themselves.
 */
export default async function ProductsPage() {
  await requirePagePermission({ product: ['read'] })
  const { organizationId } = await requirePageOrg()
  const { branchId } = await requireBranch()

  const [products, { currency }] = await Promise.all([
    listProducts(organizationId, branchId),
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

  const low = products.filter((p) => p.active && p.low)

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-medium">Produk</h1>

      {low.length > 0 && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          Stok menipis: {low.map((p) => `${p.name} (${p.onHand})`).join(', ')}
        </div>
      )}

      {products.length === 0 ? (
        <p className="text-sm text-muted-foreground">Belum ada produk.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nama</TableHead>
              <TableHead>Jenis</TableHead>
              <TableHead>Harga</TableHead>
              <TableHead>Stok</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {products.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-medium">{p.name}</TableCell>
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
      )}

      {canCreate && <ProductCreateForm />}
      {canAdjust && products.length > 0 && (
        <StockAdjustForm products={products.map((p) => ({ id: p.id, name: p.name }))} />
      )}
    </div>
  )
}
