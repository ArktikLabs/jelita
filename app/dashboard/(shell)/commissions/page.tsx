import { headers } from 'next/headers'
import { requirePagePermission, requirePageOrg } from '@/lib/session'
import { auth } from '@/lib/auth'
import { commissionRecap } from '@/lib/commission'
import { formatMoney, type CurrencyCode } from '@/lib/money'
import { buttonVariants } from '@/components/ui/button'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'

const thisMonth = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

/**
 * PRD §5.3's recap, and its "my earnings this month" in the same page.
 *
 * Guarded by commission:['read:own'] -- the weaker of the two statements, so a
 * stylist reaches it. Whether they see everyone or only themselves is decided
 * below by whether they ALSO hold commission:['read'], which owner and admin
 * do and a stylist does not.
 *
 * One query for both, narrowed by argument: two queries could disagree, and
 * the one a stylist saw would be the one nobody checked.
 */
export default async function CommissionsPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>
}) {
  const session = await requirePagePermission({ commission: ['read:own'] })
  const { organizationId } = await requirePageOrg()
  const { month: raw } = await searchParams
  const month = /^\d{4}-\d{2}-01$/.test(raw ?? '') ? raw! : thisMonth()

  const { success: seesEveryone } = await auth.api.hasPermission({
    headers: await headers(),
    body: { permissions: { commission: ['read'] } },
  })

  const rows = await commissionRecap(
    organizationId, month, seesEveryone ? null : session.user.id)
  const currency = (rows[0]?.currency ?? 'IDR') as CurrencyCode
  const liability = rows.reduce((n, r) => n + r.commission, 0)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-medium">
          {seesEveryone ? 'Komisi' : 'Pendapatan saya'}
        </h1>
        <form className="flex items-end gap-2">
          <input
            type="month"
            name="month"
            defaultValue={month.slice(0, 7)}
            className="flex h-9 rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs"
          />
          <button type="submit" className={buttonVariants({ variant: 'outline' })}>Lihat</button>
        </form>
      </div>

      {seesEveryone && (
        <p className="text-sm text-muted-foreground">
          Total komisi bulan ini:{' '}
          <span className="font-medium text-foreground">
            {formatMoney(liability, currency)}
          </span>
        </p>
      )}

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Belum ada komisi bulan itu.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Staf</TableHead>
              <TableHead>Layanan</TableHead>
              <TableHead>Omzet</TableHead>
              <TableHead>Komisi</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.staffUserId}>
                <TableCell className="font-medium">{r.staffName}</TableCell>
                <TableCell>{r.services}</TableCell>
                <TableCell>{formatMoney(r.revenue, r.currency as CurrencyCode)}</TableCell>
                <TableCell>{formatMoney(r.commission, r.currency as CurrencyCode)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
