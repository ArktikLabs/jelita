import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { getSession } from '@/lib/session'
import { PRODUCT_LIST, listProducts } from '@/lib/inventory'
import { salonSettings } from '@/lib/service'
import { formatMoney, type CurrencyCode } from '@/lib/money'
import { exportQuery } from '@/lib/list-query'
import { csvResponse } from '@/lib/list-csv'

/**
 * §8's export. Guarded by product:['read'] -- the same permission the
 * products list page uses.
 *
 * Stock is per branch (§5.8), so this needs the active branch exactly as the
 * page does; there is no salon-wide "on hand" to export instead.
 */
export async function GET(request: Request) {
  const session = await getSession()
  if (!session?.user) return new NextResponse(null, { status: 401 })

  const { success } = await auth.api.hasPermission({
    headers: await headers(),
    body: { permissions: { product: ['read'] } },
  })
  if (!success) return new NextResponse(null, { status: 403 })

  const organizationId = session.session.activeOrganizationId
  const branchId = session.session.activeTeamId
  if (!organizationId || !branchId) return new NextResponse(null, { status: 404 })

  const params = Object.fromEntries(new URL(request.url).searchParams)
  const [{ rows, total }, { currency }] = await Promise.all([
    listProducts(organizationId, branchId, exportQuery(PRODUCT_LIST, params)),
    salonSettings(organizationId),
  ])

  return csvResponse('produk',
    ['Nama', 'SKU', 'Jenis', 'Harga', 'Stok', 'Status'],
    rows.map((r) => [
      r.name,
      r.sku,
      r.kind === 'retail' ? 'Ritel' : 'Internal',
      r.price === null ? null : formatMoney(r.price, currency as CurrencyCode),
      r.onHand,
      r.active ? 'Aktif' : 'Nonaktif',
    ]),
    total)
}
