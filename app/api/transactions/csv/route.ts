import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { getSession } from '@/lib/session'
import { TRANSACTION_LIST, listSales, todayLocal } from '@/lib/pos'
import { formatMoney, type CurrencyCode } from '@/lib/money'
import { exportQuery } from '@/lib/list-query'
import { csvResponse } from '@/lib/list-csv'

const INVOICE = (n: number | null) => (n === null ? '—' : `INV-${String(n).padStart(6, '0')}`)

/**
 * §8's export. Guarded by pos:['checkout'] -- the same permission the
 * transactions page uses.
 *
 * `date` defaults to today exactly as the page does: the filter's default
 * lives on the caller, not the contract (an absent filter means "no
 * restriction" everywhere else in list-query), and FilterBar never writes a
 * filter's resolved default back into the URL -- so a bare export link
 * carries no `date` at all, and skipping this default would silently widen
 * the export to every sale ever, not the day the screen was showing.
 */
export async function GET(request: Request) {
  const session = await getSession()
  if (!session?.user) return new NextResponse(null, { status: 401 })

  const { success } = await auth.api.hasPermission({
    headers: await headers(),
    body: { permissions: { pos: ['checkout'] } },
  })
  if (!success) return new NextResponse(null, { status: 403 })

  const organizationId = session.session.activeOrganizationId
  const branchId = session.session.activeTeamId
  if (!organizationId || !branchId) return new NextResponse(null, { status: 404 })

  const params = Object.fromEntries(new URL(request.url).searchParams)
  const query = exportQuery(TRANSACTION_LIST, params)
  const date = query.filters.date ?? todayLocal()
  const { rows, total } = await listSales(
    organizationId, branchId, { ...query, filters: { ...query.filters, date } })

  return csvResponse('transaksi',
    ['No. Invoice', 'Waktu', 'Pelanggan', 'Total', 'Status'],
    rows.map((r) => [
      INVOICE(r.invoiceNo),
      r.completedAt,
      r.customerName ?? 'Tanpa nama',
      formatMoney(r.total, r.currency as CurrencyCode),
      r.reversesId ? 'Pembatalan' : r.reversedById ? 'Dibatalkan' : 'Selesai',
    ]),
    total)
}
