import Link from 'next/link'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { requirePageOrg } from '@/lib/session'
import {
  bookingFunnel, revenueByDay, revenueRange, staffPerformance, topServices,
} from '@/lib/reports'
import { lowStock } from '@/lib/inventory'
import { salonSettings } from '@/lib/service'
import { formatMoney, type CurrencyCode } from '@/lib/money'
import { buttonVariants } from '@/components/ui/button'
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { RevenueTrend, TopServicesChart } from './charts'

/**
 * PRD §5.6, and the landing page for EVERY role.
 *
 * There is deliberately no permission guard on this page: it is where everyone
 * arrives after signing in, and `report` is held by owner and admin alone.
 * Instead the same sections are SCOPED to the viewer -- a stylist sees their
 * own revenue, services, commission and no-show rate, which is the useful
 * answer to "what does the dashboard show me" (spec §2.1).
 *
 * Two figures are absent rather than scoped for a stylist: salon revenue (their
 * own replaces it) and low stock, which is not theirs to act on.
 */
const iso = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const shift = (days: number) => {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return iso(d)
}

const PRESETS: [string, string, string][] = [
  ['Hari ini', shift(0), shift(0)],
  ['7 hari', shift(-6), shift(0)],
  ['30 hari', shift(-29), shift(0)],
]

const isDate = (v?: string) => /^\d{4}-\d{2}-\d{2}$/.test(v ?? '')

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>
}) {
  const session = await requirePageOrg()
  const { organizationId } = session
  const q = await searchParams
  const from = isDate(q.from) ? q.from! : shift(-6)
  const to = isDate(q.to) ? q.to! : shift(0)

  const [{ success: seesAll }, { success: seesOwn }, { success: canExport }] =
    await Promise.all([
    auth.api.hasPermission({
      headers: await headers(), body: { permissions: { report: ['read'] } },
    }),
    auth.api.hasPermission({
      headers: await headers(), body: { permissions: { commission: ['read:own'] } },
    }),
    auth.api.hasPermission({
      headers: await headers(), body: { permissions: { report: ['export'] } },
    }),
  ])

  // Read straight off the session rather than requireBranch(), which THROWS
  // when there is no active branch. This page must render for anyone who can
  // sign in, including the moment after onboarding -- tests/e2e/ui.spec.ts
  // asserts it answers 200 there.
  const teamId = session.session.activeTeamId
  if (!teamId || (!seesAll && !seesOwn)) {
    return (
      <div className="space-y-2">
        <h1 className="text-xl font-medium">Dasbor</h1>
        <p className="text-sm text-muted-foreground">
          Pilih menu di atas untuk mulai bekerja.
        </p>
      </div>
    )
  }

  const staffUserId = seesAll ? null : session.user.id
  const scope = { organizationId, teamId, from, to, staffUserId }

  const [{ currency }, revenue, byDay, services, staff, funnel, low] = await Promise.all([
    salonSettings(organizationId),
    revenueRange(scope),
    revenueByDay(scope),
    topServices(scope),
    staffPerformance(scope),
    bookingFunnel(scope),
    seesAll ? lowStock(organizationId, teamId) : Promise.resolve([]),
  ])

  const link = (f: string, t: string) => `/dashboard?from=${f}&to=${t}`
  const mine = staff.find((r) => r.staffUserId === staffUserId)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-medium">
          {seesAll ? 'Dasbor' : 'Ringkasan saya'}
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          {PRESETS.map(([label, f, t]) => (
            <Link
              key={label}
              href={link(f, t)}
              className={buttonVariants({
                variant: from === f && to === t ? 'default' : 'outline', size: 'sm',
              })}
            >
              {label}
            </Link>
          ))}
          {canExport && (
            <Link
              href={`/api/reports/csv?section=staff&from=${from}&to=${to}`}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
              prefetch={false}
            >
              Unduh CSV
            </Link>
          )}
          <form className="flex items-end gap-1">
            <input type="date" name="from" defaultValue={from} className={dateInput} />
            <input type="date" name="to" defaultValue={to} className={dateInput} />
            <button type="submit" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              Terapkan
            </button>
          </form>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        <Stat
          label={seesAll ? 'Omzet' : 'Omzet saya'}
          value={formatMoney(revenue, currency as CurrencyCode)}
        />
        <Stat label="Janji temu" value={String(funnel.total)} />
        <Stat label="Selesai" value={`${funnel.completionRate}%`} />
        <Stat label="Tidak datang" value={`${funnel.noShowRate}%`} />
      </div>

      {!seesAll && mine && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Stat label="Layanan dikerjakan" value={String(mine.services)} />
          <Stat
            label="Komisi"
            value={formatMoney(mine.commission, currency as CurrencyCode)}
          />
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{seesAll ? 'Omzet harian' : 'Omzet saya per hari'}</CardTitle>
          <CardDescription>{from} sampai {to}</CardDescription>
        </CardHeader>
        <CardContent>
          <RevenueTrend data={byDay} currency={currency as CurrencyCode} />
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Layanan teratas — omzet</CardTitle></CardHeader>
          <CardContent>
            <TopServicesChart
              data={services.byRevenue}
              currency={currency as CurrencyCode}
              measure="revenue"
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Layanan teratas — jumlah</CardTitle></CardHeader>
          <CardContent>
            <TopServicesChart
              data={services.byCount}
              currency={currency as CurrencyCode}
              measure="count"
            />
          </CardContent>
        </Card>
      </div>

      {seesAll && (
        <Card>
          <CardHeader>
            <CardTitle>Kinerja staf</CardTitle>
            <CardDescription>
              <Link href="/dashboard/commissions" className="underline">
                Rekap komisi
              </Link>{' '}
              untuk penggajian.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {staff.length === 0 ? (
              <p className="text-sm text-muted-foreground">Belum ada data.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Staf</TableHead>
                    <TableHead>Omzet</TableHead>
                    <TableHead>Layanan</TableHead>
                    <TableHead>Komisi</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {staff.map((r) => (
                    <TableRow key={r.staffUserId}>
                      <TableCell className="font-medium">{r.name}</TableCell>
                      <TableCell>{formatMoney(r.revenue, currency as CurrencyCode)}</TableCell>
                      <TableCell>{r.services}</TableCell>
                      <TableCell>
                        {formatMoney(r.commission, currency as CurrencyCode)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {seesAll && low.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Stok menipis</CardTitle>
            <CardDescription>
              <Link href="/dashboard/products" className="underline">Kelola produk</Link>
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm">
            {low.map((p) => `${p.name} (${p.onHand})`).join(', ')}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

const dateInput =
  'flex h-8 rounded-md border bg-transparent px-2 py-1 text-sm shadow-xs'

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-medium" data-testid={`kpi-${label}`}>{value}</div>
    </div>
  )
}
