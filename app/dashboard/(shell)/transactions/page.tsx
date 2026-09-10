import Link from 'next/link'
import { headers } from 'next/headers'
import { requireBranch, requirePagePermission, requirePageOrg } from '@/lib/session'
import { auth } from '@/lib/auth'
import { TRANSACTION_LIST, listSales, openShift, todayLocal } from '@/lib/pos'
import { formatMoney, type CurrencyCode } from '@/lib/money'
import { parseListQuery, wasTruncated } from '@/lib/list-query'
import { clearFilters, listHref, type Params } from '@/lib/list-url'
import { buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { SortableHead } from '@/components/list/sortable-head'
import { FilterBar } from '@/components/list/filter-bar'
import { Pagination } from '@/components/list/pagination'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { CloseShiftButton, VoidButton } from './sale-actions'

export const INVOICE = (n: number | null) =>
  (n === null ? '—' : `INV-${String(n).padStart(6, '0')}`)

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Params>
}) {
  await requirePagePermission({ pos: ['checkout'] })
  const { organizationId } = await requirePageOrg()
  const { branchId } = await requireBranch()
  const params = await searchParams
  const query = parseListQuery(TRANSACTION_LIST, params)
  // The date filter's default (today) lives on the PAGE, not the contract --
  // a bare/bookmarked `/transactions` URL must keep showing today's sales,
  // exactly as the old regex-and-fallback did, while an absent filter means
  // "no restriction" everywhere else in the contract.
  const date = query.filters.date ?? todayLocal()

  const [sales, shift] = await Promise.all([
    listSales(organizationId, branchId, { ...query, filters: { ...query.filters, date } }),
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
        <div className="flex items-center gap-2">
          {/* The export must carry the CURRENT view, so it reuses the same
              searchParams the list was built from. */}
          <a
            href={`/api/transactions/csv?${new URLSearchParams(
              Object.entries(params).filter(([, v]) => typeof v === 'string') as [string, string][],
            )}`}
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            Ekspor CSV
          </a>
          <Link href="/dashboard/pos" className={buttonVariants()}>Kasir</Link>
        </div>
      </div>

      {/* §8: the CSV export caps at 10.000 rows and says so IN THE FILE
          (lib/list-csv.ts) -- this is the same warning on the SCREEN. */}
      {wasTruncated(sales.total) && (
        <p className="text-sm text-muted-foreground">
          Ekspor CSV akan dipotong pada 10.000 baris dari {sales.total} transaksi yang cocok.
          Persempit filter untuk mengekspor sisanya.
        </p>
      )}

      {shift && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm">
          <span>
            Shift dibuka {shift.openedAt.slice(11)} — {shift.sales} transaksi,{' '}
            {formatMoney(shift.takings, (sales.rows[0]?.currency ?? 'IDR') as CurrencyCode)}
          </span>
          {/* Closing locks these takings: a sale can be voided while its shift
              is open and not after (spec 2.7). */}
          <CloseShiftButton id={shift.id} />
        </div>
      )}

      <FilterBar
        spec={TRANSACTION_LIST}
        query={query}
        params={params}
        controls={{ date: { type: 'date', label: 'Tanggal', value: date } }}
      />

      {sales.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {/* query.filters.date, not the resolved `date` above: `date` always
              has a value (the page's own today-default), so it can't tell
              "nothing happened today" from "you picked a date with nothing on
              it" apart -- only the RAW filter, undefined when the user never
              chose one, can. */}
          {query.filters.date === undefined ? (
            'Belum ada transaksi hari itu.'
          ) : (
            <>
              Tidak ada transaksi yang cocok dengan filter ini.{' '}
              <Link href={listHref(params, clearFilters(TRANSACTION_LIST))} className="underline">
                Hapus filter
              </Link>
            </>
          )}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <SortableHead column="invoice" label="No." spec={TRANSACTION_LIST} query={query} params={params} />
              <SortableHead column="completed" label="Jam" spec={TRANSACTION_LIST} query={query} params={params} />
              <TableHead>Pelanggan</TableHead>
              <TableHead>Total</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sales.rows.map((s) => (
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

      <Pagination result={sales} params={params} />
    </div>
  )
}
