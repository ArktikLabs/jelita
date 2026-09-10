import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { getSession } from '@/lib/session'
import { CUSTOMER_LIST, listCustomers } from '@/lib/customer'
import { exportQuery } from '@/lib/list-query'
import { csvResponse } from '@/lib/list-csv'

/**
 * §8's export. A ROUTE, not a Server Action: an action returns a value to the
 * page and cannot hand the browser a Content-Disposition.
 *
 * Guarded by customer:['read'] -- the SAME permission the list page uses, per
 * §8: this is the data already on the screen, and a second permission would
 * only create a way for the two to disagree.
 */
export async function GET(request: Request) {
  const session = await getSession()
  if (!session?.user) return new NextResponse(null, { status: 401 })

  const { success } = await auth.api.hasPermission({
    headers: await headers(),
    body: { permissions: { customer: ['read'] } },
  })
  if (!success) return new NextResponse(null, { status: 403 })

  const organizationId = session.session.activeOrganizationId
  if (!organizationId) return new NextResponse(null, { status: 404 })

  const params = Object.fromEntries(new URL(request.url).searchParams)
  const { rows, total } = await listCustomers(organizationId, exportQuery(CUSTOMER_LIST, params))

  return csvResponse('pelanggan',
    ['Nama', 'Telepon', 'Status', 'Dibuat'],
    rows.map((r) => [r.name, r.phone, r.active ? 'Aktif' : 'Nonaktif', r.createdAt]),
    total)
}
