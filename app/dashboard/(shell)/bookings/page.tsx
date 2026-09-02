import Link from 'next/link'
import { requirePagePermission, requirePageOrg, requireBranch } from '@/lib/session'
import { listBookings } from '@/lib/booking'
import { formatMoney } from '@/lib/money'
import { type CurrencyCode } from '@/lib/money'
import { buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { StatusActions } from './status-form'

const STATUS: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' }> = {
  pending: { label: 'Menunggu', variant: 'secondary' },
  confirmed: { label: 'Terkonfirmasi', variant: 'default' },
  completed: { label: 'Selesai', variant: 'default' },
  cancelled: { label: 'Batal', variant: 'destructive' },
  no_show: { label: 'Tidak datang', variant: 'destructive' },
}

/** Wall-clock today, matching how bookings are stored (spec 2.6). */
const todayLocal = () => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export default async function BookingsPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>
}) {
  await requirePagePermission({ booking: ['read'] })
  const { organizationId } = await requirePageOrg()
  // The branch comes from the session, never a query string: a posted team id
  // would show a front-desk user a branch they cannot switch to.
  const { branchId } = await requireBranch()
  const { date: raw } = await searchParams
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw ?? '') ? raw! : todayLocal()

  const day = await listBookings(organizationId, branchId, date)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-medium">Janji temu</h1>
        <div className="flex items-center gap-2">
          <Link
            href={`/dashboard/bookings/calendar?date=${date}`}
            className={buttonVariants({ variant: 'outline' })}
          >
            Kalender
          </Link>
          <Link
            href="/dashboard/bookings/new?walkIn=1"
            className={buttonVariants({ variant: 'outline' })}
          >
            Datang langsung
          </Link>
          <Link href="/dashboard/bookings/new" className={buttonVariants()}>
            Buat janji temu
          </Link>
        </div>
      </div>

      <form className="flex items-end gap-2">
        <div className="space-y-2">
          <label htmlFor="date" className="text-sm font-medium">Tanggal</label>
          <input
            id="date"
            type="date"
            name="date"
            defaultValue={date}
            className="flex h-9 rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs"
          />
        </div>
        <button type="submit" className={buttonVariants({ variant: 'outline' })}>
          Lihat
        </button>
      </form>

      {day.length === 0 ? (
        <p className="text-sm text-muted-foreground">Belum ada janji temu hari itu.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Jam</TableHead>
              <TableHead>Pelanggan</TableHead>
              <TableHead>Layanan</TableHead>
              <TableHead>Staf</TableHead>
              <TableHead>Harga</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {day.map((b) => (
              <TableRow key={b.id}>
                <TableCell className="font-medium">
                  {b.startsAt.slice(11)}–{b.endsAt.slice(11)}
                </TableCell>
                <TableCell>{b.customerName}</TableCell>
                <TableCell>{b.serviceName}</TableCell>
                <TableCell>{b.staffName}</TableCell>
                <TableCell>{formatMoney(b.price, b.currency as CurrencyCode)}</TableCell>
                <TableCell>
                  <Badge variant={STATUS[b.status]?.variant ?? 'secondary'}>
                    {STATUS[b.status]?.label ?? b.status}
                  </Badge>
                </TableCell>
                <TableCell>
                  <StatusActions id={b.id} status={b.status} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
