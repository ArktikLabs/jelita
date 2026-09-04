import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { getSession } from '@/lib/session'
import { payrollRecap } from '@/lib/payroll'
import { toCsv } from '@/lib/csv'
import { formatMoney, type CurrencyCode } from '@/lib/money'

/**
 * PRD §5.9's acceptance criterion: "one screen, one click to export".
 *
 * Its own route rather than a fourth section of /api/reports/csv, for two
 * reasons that are not stylistic.
 *
 * The GUARD. This is payroll:['read'], not report:['export']. Both resolve to
 * owner and admin today, so the distinction buys nothing this week -- but
 * custom roles are enabled, and the day somebody grants a manager
 * report:['export'] they must not silently receive everyone's salary with it.
 * A permission should name the data it protects.
 *
 * The PERIOD. Payroll is a MONTH, not a date range: a closed month reads its
 * frozen snapshot, and "from the 3rd to the 19th" has no meaning against a
 * figure that was locked for a calendar month.
 */
export async function GET(request: Request) {
  const session = await getSession()
  if (!session?.user) return new NextResponse(null, { status: 401 })

  const { success } = await auth.api.hasPermission({
    headers: await headers(),
    body: { permissions: { payroll: ['read'] } },
  })
  if (!success) return new NextResponse(null, { status: 403 })

  const organizationId = session.session.activeOrganizationId
  if (!organizationId) return new NextResponse(null, { status: 404 })

  const month = new URL(request.url).searchParams.get('month') ?? ''
  if (!/^\d{4}-\d{2}-01$/.test(month)) return new NextResponse(null, { status: 400 })

  const rows = await payrollRecap(organizationId, month)
  const currency = (rows[0]?.currency ?? 'IDR') as CurrencyCode
  const money = (n: number) => formatMoney(n, currency)

  const body = toCsv(
    ['Staf', 'Peran', 'Gaji pokok', 'Komisi', 'Potongan', 'Take-home'],
    rows.map((r) => [
      r.name,
      r.role,
      // Null base salary is NOT zero -- it means commission-only, and a CSV
      // that prints "Rp 0" invites somebody to pay a stylist their salary.
      r.baseSalary === null ? '—' : money(r.baseSalary),
      money(r.commission),
      money(r.deductions),
      money(r.net),
    ]))

  return new NextResponse(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="penggajian-${month.slice(0, 7)}.csv"`,
      // A recap is a snapshot of a moment; a cached one is a wrong one.
      'cache-control': 'no-store',
    },
  })
}
