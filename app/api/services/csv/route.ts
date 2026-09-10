import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { getSession } from '@/lib/session'
import { SERVICE_LIST, listServices, salonSettings } from '@/lib/service'
import { formatMoney, type CurrencyCode } from '@/lib/money'
import { exportQuery } from '@/lib/list-query'
import { csvResponse } from '@/lib/list-csv'

const UNCATEGORISED = 'Tanpa kategori'

/**
 * §8's export. Guarded by service:['update'] -- the SAME permission the
 * services page uses (not ['read']: catalogue management, not booking/POS's
 * read of a price, per the page's own note).
 */
export async function GET(request: Request) {
  const session = await getSession()
  if (!session?.user) return new NextResponse(null, { status: 401 })

  const { success } = await auth.api.hasPermission({
    headers: await headers(),
    body: { permissions: { service: ['update'] } },
  })
  if (!success) return new NextResponse(null, { status: 403 })

  const organizationId = session.session.activeOrganizationId
  if (!organizationId) return new NextResponse(null, { status: 404 })

  const params = Object.fromEntries(new URL(request.url).searchParams)
  const [{ rows, total }, { currency }] = await Promise.all([
    listServices(organizationId, exportQuery(SERVICE_LIST, params)),
    salonSettings(organizationId),
  ])

  return csvResponse('layanan',
    ['Nama', 'Kategori', 'Durasi', 'Harga', 'Status'],
    rows.map((r) => [
      r.name,
      r.categoryName ?? UNCATEGORISED,
      `${r.durationMinutes} menit`,
      formatMoney(r.price, currency as CurrencyCode),
      r.active ? 'Aktif' : 'Nonaktif',
    ]),
    total)
}
