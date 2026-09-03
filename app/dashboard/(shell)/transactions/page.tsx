import Link from 'next/link'
import { headers } from 'next/headers'
import { requireBranch, requirePagePermission, requirePageOrg } from '@/lib/session'
import { auth } from '@/lib/auth'
import { listSales, openShift } from '@/lib/pos'
import { formatMoney, type CurrencyCode } from '@/lib/money'
import { buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { CloseShiftButton, VoidButton } from './sale-actions'

const todayLocal = () => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export const INVOICE = (n: number | null) =>
  (n === null ? '—' : `INV-${String(n).padStart(6, '0')}`)

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>
}) {
  await requirePagePermission({ pos: ['checkout'] })
  const { organizationId } = await requirePageOrg()
  const { branchId } = await requireBranch()
  const { date: raw } = await searchParams
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw ?? '') ? raw! : todayLocal()

  const [sales, shift] = await Promise.all([
    listSales(organizationId, branchId, date),
    openShift(organizationId, branchId),
  ])
  const { success: canVoid } = await auth.api.hasPermission({
    headers: await headers(),
    body: { permissions: { pos: ['void'] } },
  })

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-medium">Transaksi</h1>
        <Link href="/dashboard/pos" className={buttonVariants()}>Kasir</Link>
      </div>

      {shift && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm">
          <span>
            Shift dibuka {shift.openedAt.slice(11)} — {shift.sales} transaksi,{' '}
            {formatMoney(shift.takings, (sales[0]?.currency ?? 'IDR') as CurrencyCode)}
          </span>
          {/* Closing locks these takings: a sale can be voided while its shift
              is open and not after (spec 2.7). */}
          <CloseShiftButton id={shift.id} />
        </div>
      )}

      <form className="flex items-end gap-2">
        <div className="space-y-2">
          <label htmlFor="date" className="text-sm font-medium">Tanggal</label>
          <input
            id="date" type="date" name="date" defaultValue={date}
            className="flex h-9 rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs"
          />
        </div>
        <button type="submit" className={buttonVariants({ variant: 'outline' })}>Lihat</button>
      </form>

      {sales.length === 0 ? (
        <p className="text-sm text-muted-foreground">Belum ada transaksi hari itu.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>No.</TableHead>
              <TableHead>Jam</TableHead>
              <TableHead>Pelanggan</TableHead>
              <TableHead>Total</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sales.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="font-medium">
                  <Link href={`/dashboard/transactions/${s.id}`} className="underline">
                    {INVOICE(s.invoiceNo)}
                  </Link>
                </TableCell>
                <TableCell>{s.completedAt?.slice(11) ?? '—'}</TableCell>
                <TableCell>{s.customerName ?? 'Tanpa nama'}</TableCell>
                <TableCell>{formatMoney(s.total, s.currency as CurrencyCode)}</TableCell>
                <TableCell>
                  <Badge variant={s.reversesId ? 'destructive' : s.reversedById ? 'secondary' : 'default'}>
                    {s.reversesId ? 'Pembatalan' : s.reversedById ? 'Dibatalkan' : 'Selesai'}
                  </Badge>
                </TableCell>
                <TableCell>
                  {/* Not offered once the shift has closed or the sale is
                      already reversed -- the trigger refuses both anyway, but
                      a button that can only fail reads as a broken app. */}
                  {canVoid && !s.reversesId && !s.reversedById && !s.shiftClosed && (
                    <VoidButton id={s.id} />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
