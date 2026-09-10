import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { getSession } from '@/lib/session'
import { BRANCH_LIST, listBranches } from '@/lib/branch'
import { exportQuery } from '@/lib/list-query'
import { csvResponse } from '@/lib/list-csv'

/**
 * §8's export. Guarded by branch:['update'] -- the same permission the
 * branches page uses. NOT branch:['read']: frontdesk (lib/permissions.ts)
 * and stylist both hold read without update, so relaxing this guard would
 * hand every front-desk worker and stylist every branch's name, address and
 * phone -- unlike report:export or payroll:lock, this is a real distinction,
 * not just an unexercised one. Pinned by tests/permissions.test.ts.
 */
export async function GET(request: Request) {
  const session = await getSession()
  if (!session?.user) return new NextResponse(null, { status: 401 })

  const { success } = await auth.api.hasPermission({
    headers: await headers(),
    body: { permissions: { branch: ['update'] } },
  })
  if (!success) return new NextResponse(null, { status: 403 })

  const organizationId = session.session.activeOrganizationId
  if (!organizationId) return new NextResponse(null, { status: 404 })

  const params = Object.fromEntries(new URL(request.url).searchParams)
  const { rows, total } = await listBranches(organizationId, exportQuery(BRANCH_LIST, params))

  // Same three-way status the page shows, not a plain active/inactive: a
  // locked-but-active branch reads very differently to whoever opens this.
  const status = (b: (typeof rows)[number]) =>
    !b.active ? 'Nonaktif' : b.withinCap ? 'Aktif' : 'Terkunci — upgrade'

  return csvResponse('cabang',
    ['Nama', 'Alamat', 'Telepon', 'Status', 'Staf'],
    rows.map((r) => [r.name, r.address, r.phone, status(r), r.staffCount]),
    total)
}
