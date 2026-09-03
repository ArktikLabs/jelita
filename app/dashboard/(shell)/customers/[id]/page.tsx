import { notFound } from 'next/navigation'
import { requirePageOrg, requirePagePermission } from '@/lib/session'
import { customerProfile, getCustomer } from '@/lib/customer'
import { CustomerDetailForm, CustomerStatusForm } from './customer-detail-forms'
import Link from 'next/link'
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { formatMoney, type CurrencyCode } from '@/lib/money'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  await requirePagePermission({ customer: ['update'] })
  const { organizationId } = await requirePageOrg()
  const { id } = await params
  // Scoped by organizationId in the query, so another salon's id is a 404
  // rather than a leak.
  const customer = await getCustomer(id, organizationId)
  if (!customer) notFound()
  // PRD §5.7's profile. Read-only: everything here already exists in the
  // ledger and the bookings table.
  const profile = await customerProfile(id, organizationId)
  const currency = profile.currency as CurrencyCode

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-medium">{customer.name}</h1>
        <Link
          href={`/dashboard/pos?customer=${customer.id}`}
          className={buttonVariants({ size: 'sm' })}
        >
          Kasir
        </Link>
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        <Stat label="Total belanja" value={formatMoney(profile.spend, currency)} />
        <Stat label="Kunjungan" value={String(profile.visits)} />
        <Stat label="Terakhir" value={profile.lastVisit ?? '—'} />
        {/* Left out entirely when the salon runs no loyalty scheme -- a zero
            balance would read as "you have earned nothing". */}
        {profile.points !== null && (
          <Stat label="Poin" value={String(profile.points)} />
        )}
      </div>

      {profile.upcoming.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Janji temu berikutnya</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            {profile.upcoming.map((b) => (
              <div key={b.id} className="flex justify-between">
                <span>
                  {b.startsAt.slice(0, 10)} {b.startsAt.slice(11)} — {b.serviceName}
                </span>
                <span className="text-muted-foreground">{b.staffName}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Riwayat kunjungan</CardTitle>
          <CardDescription>20 transaksi terakhir.</CardDescription>
        </CardHeader>
        <CardContent>
          {profile.visitHistory.length === 0 ? (
            <p className="text-sm text-muted-foreground">Belum ada transaksi.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tanggal</TableHead>
                  <TableHead>Layanan</TableHead>
                  <TableHead>Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {profile.visitHistory.map((v) => (
                  <TableRow key={v.id}>
                    <TableCell>
                      <Link href={`/dashboard/transactions/${v.id}`} className="underline">
                        {v.at}
                      </Link>
                      {v.reversal && (
                        <Badge variant="destructive" className="ml-2">Pembatalan</Badge>
                      )}
                    </TableCell>
                    <TableCell>{v.items}</TableCell>
                    <TableCell>{formatMoney(v.total, v.currency as CurrencyCode)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Detail</CardTitle></CardHeader>
        <CardContent>
          <CustomerDetailForm customer={{
            id: customer.id,
            name: customer.name,
            phone: customer.phone,
            notes: customer.notes,
          }} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Status</CardTitle>
          <CardDescription>
            Pelanggan nonaktif tetap tersimpan beserta riwayatnya.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CustomerStatusForm customer={{ id: customer.id, active: customer.active }} />
        </CardContent>
      </Card>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-medium" data-testid={`stat-${label}`}>{value}</div>
    </div>
  )
}
