import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { getSession } from '@/lib/session'
import { revenueByDay, staffPerformance, topServices } from '@/lib/reports'
import { csvFilename, toCsv } from '@/lib/csv'
import { formatMoney, type CurrencyCode } from '@/lib/money'
import { salonSettings } from '@/lib/service'

/**
 * §5.6's "export to CSV".
 *
 * A ROUTE, not a Server Action: an action returns a value to the page, and
 * cannot hand the browser a file with a Content-Disposition.
 *
 * Guarded by report:['export'], a statement distinct from ['read'] -- reading
 * a figure on screen and carrying the whole table out of the building are
 * different acts. No built-in role separates them today, so
 * tests/permissions.test.ts pins that overlap and the guard becomes
 * falsifiable the moment one does.
 *
 * Deliberately NOT scoped to a stylist: a role that cannot export at all never
 * reaches this, so there is no "their own rows" case to write.
 */
const SECTIONS = ['revenue', 'services', 'staff'] as const
type Section = (typeof SECTIONS)[number]

const isDate = (v: string | null) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v)

export async function GET(request: Request) {
  const session = await getSession()
  if (!session?.user) return new NextResponse(null, { status: 401 })

  const { success } = await auth.api.hasPermission({
    headers: await headers(),
    body: { permissions: { report: ['export'] } },
  })
  if (!success) return new NextResponse(null, { status: 403 })

  const organizationId = session.session.activeOrganizationId
  const teamId = session.session.activeTeamId
  if (!organizationId || !teamId) return new NextResponse(null, { status: 404 })

  const url = new URL(request.url)
  const section = url.searchParams.get('section') ?? ''
  const from = url.searchParams.get('from')
  const to = url.searchParams.get('to')
  if (!SECTIONS.includes(section as Section)) return new NextResponse(null, { status: 400 })
  if (!isDate(from) || !isDate(to)) return new NextResponse(null, { status: 400 })

  const scope = { organizationId, teamId, from: from!, to: to! }
  const { currency } = await salonSettings(organizationId)
  const money = (n: number) => formatMoney(n, currency as CurrencyCode)

  let body: string
  if (section === 'revenue') {
    const rows = await revenueByDay(scope)
    body = toCsv(['Tanggal', 'Omzet'], rows.map((r) => [r.day, money(r.revenue)]))
  } else if (section === 'services') {
    const { byRevenue } = await topServices(scope, 100)
    body = toCsv(['Layanan', 'Omzet', 'Jumlah'],
      byRevenue.map((r) => [r.name, money(r.revenue), r.count]))
  } else {
    const rows = await staffPerformance(scope)
    body = toCsv(['Staf', 'Omzet', 'Layanan', 'Komisi'],
      rows.map((r) => [r.name, money(r.revenue), r.services, money(r.commission)]))
  }

  return new NextResponse(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${csvFilename(section, from!, to!)}"`,
      // A report is a snapshot of a moment; a cached one is a wrong one.
      'cache-control': 'no-store',
    },
  })
}
