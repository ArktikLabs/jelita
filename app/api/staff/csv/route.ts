import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { getSession } from '@/lib/session'
import { STAFF_LIST, listStaff } from '@/lib/staff'
import { exportQuery } from '@/lib/list-query'
import { csvResponse } from '@/lib/list-csv'

/**
 * §8's export. Guarded by staff:['read'] -- the same permission the staff
 * page uses.
 *
 * `role` is exported EXACTLY as `listStaff` returns it -- a comma-joined
 * union built with `string_agg`, because a person can hold more than one
 * membership row (lib/staff.ts). Taking the first element (or mapping
 * through the page's ROLE_LABEL, which only knows single values) would
 * under-report someone's access, so this is the one column deliberately
 * left untranslated.
 */
export async function GET(request: Request) {
  const session = await getSession()
  if (!session?.user) return new NextResponse(null, { status: 401 })

  const { success } = await auth.api.hasPermission({
    headers: await headers(),
    body: { permissions: { staff: ['read'] } },
  })
  if (!success) return new NextResponse(null, { status: 403 })

  const organizationId = session.session.activeOrganizationId
  if (!organizationId) return new NextResponse(null, { status: 404 })

  const params = Object.fromEntries(new URL(request.url).searchParams)
  const { rows, total } = await listStaff(organizationId, exportQuery(STAFF_LIST, params))

  return csvResponse('staf',
    ['Nama', 'Email', 'Peran', 'Cabang', 'Status'],
    rows.map((r) => [r.name, r.email, r.role, r.branchName, r.active ? 'Aktif' : 'Nonaktif']),
    total)
}
