import { requirePagePermission, requirePageOrg } from '@/lib/session'
import { listDeductions, payrollRecap, payrollRun } from '@/lib/payroll'
import { formatMoney, type CurrencyCode } from '@/lib/money'
import { buttonVariants } from '@/components/ui/button'
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { ClosePayrollButton, DeductionForm, RemoveDeductionButton } from './payroll-forms'

const thisMonth = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

/**
 * PRD §5.9's recap. payroll:['read'] is owner and admin; nobody else holds any
 * payroll statement at all.
 */
export default async function PayrollPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>
}) {
  await requirePagePermission({ payroll: ['read'] })
  const { organizationId } = await requirePageOrg()
  const { month: raw } = await searchParams
  const month = /^\d{4}-\d{2}-01$/.test(raw ?? '') ? raw! : thisMonth()

  const [rows, deductions, closed] = await Promise.all([
    payrollRecap(organizationId, month),
    listDeductions(organizationId, month),
    payrollRun(organizationId, month),
  ])
  const currency = (rows[0]?.currency ?? 'IDR') as CurrencyCode
  const total = rows.reduce((n, r) => n + r.net, 0)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-medium">Penggajian</h1>
        <form className="flex items-end gap-2">
          <input
            type="month" name="month" defaultValue={month.slice(0, 7)}
            className="flex h-9 rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs"
          />
          <button type="submit" className={buttonVariants({ variant: 'outline' })}>Lihat</button>
        </form>
      </div>

      {/* §5.9: "one screen, one click to export". A plain link, not a form:
          the browser downloads it and the page stays where it is. */}
      <a
        href={`/api/payroll/csv?month=${month}`}
        className={buttonVariants({ variant: 'outline', size: 'sm' })}
      >
        Unduh CSV
      </a>

      <p className="text-sm text-muted-foreground">
        Total dibayarkan bulan ini:{' '}
        <span className="font-medium text-foreground">{formatMoney(total, currency)}</span>
      </p>

      {closed ? (
        <p className="rounded-md border p-3 text-sm" data-testid="payroll-closed">
          Ditutup {closed.closedAt}. Angka di bawah ini adalah snapshot saat penutupan
          dan tidak berubah lagi.
        </p>
      ) : (
        <ClosePayrollButton month={month} />
      )}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Staf</TableHead>
            <TableHead>Gaji pokok</TableHead>
            <TableHead>Komisi</TableHead>
            <TableHead>Potongan</TableHead>
            <TableHead>Diterima</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.userId}>
              <TableCell className="font-medium">{r.name}</TableCell>
              <TableCell data-testid={`base-${r.userId}`}>
                {/* A dash, not Rp 0: this person is not salaried, which is a
                    different statement from salaried at nothing. */}
                {r.baseSalary === null ? '—' : formatMoney(r.baseSalary, currency)}
              </TableCell>
              <TableCell>{formatMoney(r.commission, currency)}</TableCell>
              <TableCell>
                {r.deductions === 0 ? '—' : `−${formatMoney(r.deductions, currency)}`}
              </TableCell>
              <TableCell data-testid={`net-${r.userId}`}>
                {formatMoney(r.net, currency)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Card>
        <CardHeader>
          <CardTitle>Potongan</CardTitle>
          <CardDescription>
            Seragam, produk yang dibawa pulang, kasbon. Gaji pokok diatur di halaman staf.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {deductions.length > 0 && (
            <ul className="divide-y rounded-md border text-sm">
              {deductions.map((d) => (
                <li key={d.id} className="flex items-center gap-2 p-2">
                  <span className="flex-1">
                    {d.staffName}
                    {d.note && <span className="text-muted-foreground"> — {d.note}</span>}
                  </span>
                  <span>{formatMoney(d.amount, currency)}</span>
                  {/* A closed month refuses the write anyway; not offering the
                      button keeps it from reading as a broken app. */}
                  {!closed && <RemoveDeductionButton id={d.id} />}
                </li>
              ))}
            </ul>
          )}
          {closed ? (
            <p className="text-sm text-muted-foreground">
              Bulan ini sudah ditutup. Catat koreksi di bulan berikutnya.
            </p>
          ) : (
            <DeductionForm
              month={month}
              staff={rows.map((r) => ({ userId: r.userId, name: r.name }))}
            />
          )}
        </CardContent>
      </Card>
    </div>
  )
}
