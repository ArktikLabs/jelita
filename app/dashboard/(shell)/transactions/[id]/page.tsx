import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requirePagePermission, requirePageOrg } from '@/lib/session'
import { getSale } from '@/lib/pos'
import { salonSettings } from '@/lib/service'
import { formatMoney, type CurrencyCode } from '@/lib/money'
import { buttonVariants } from '@/components/ui/button'
import { PrintButton } from './print-button'

const METHOD_LABEL: Record<string, string> = {
  cash: 'Tunai', transfer: 'Transfer', qris: 'QRIS', debit: 'Debit', credit: 'Kredit',
}

const invoice = (n: number | null) => (n === null ? '—' : `INV-${String(n).padStart(6, '0')}`)

/**
 * The receipt. Printable via the browser rather than a PDF library: print-to-
 * PDF satisfies both halves of §5.2's "printable/PDF" without a dependency, a
 * font-embedding problem, and a second rendering path that drifts from what is
 * on screen.
 *
 * Branding comes from salon_profiles (PRD §7's white-label line) -- the logo
 * through /api/salon/logo, never a bucket URL.
 */
export default async function ReceiptPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  await requirePagePermission({ pos: ['checkout'] })
  const { organizationId } = await requirePageOrg()
  const { id } = await params

  const sale = await getSale(id, organizationId)
  if (!sale) notFound()
  const salon = await salonSettings(organizationId)

  const currency = sale.currency as CurrencyCode
  const reversal = sale.status === 'reversal'
  const slug = await salonSlug(organizationId)

  return (
    <div className="mx-auto max-w-md space-y-4">
      <div className="flex items-center justify-between print:hidden">
        <Link href="/dashboard/transactions" className={buttonVariants({ variant: 'outline' })}>
          Kembali
        </Link>
        <PrintButton />
      </div>

      <article
        className="space-y-4 rounded-md border p-6 print:border-0 print:p-0"
        style={salon.brandColor ? { borderColor: salon.brandColor } : undefined}
      >
        <header className="space-y-1 text-center">
          {salon.hasLogo && (
            // eslint-disable-next-line @next/next/no-img-element -- the route
            // streams from object storage; next/image would only add a second
            // optimiser in front of a 50 KB file.
            <img
              src={`/api/salon/logo?salon=${slug}&v=${salon.logoVersion}`}
              alt=""
              className="mx-auto h-12 w-auto"
            />
          )}
          <h1
            className="text-lg font-medium"
            style={salon.brandColor ? { color: salon.brandColor } : undefined}
          >
            {sale.branchName}
          </h1>
          {sale.branchAddress && (
            <p className="text-xs text-muted-foreground">{sale.branchAddress}</p>
          )}
          {sale.branchPhone && (
            <p className="text-xs text-muted-foreground">{sale.branchPhone}</p>
          )}
        </header>

        <div className="flex justify-between border-y py-2 text-sm">
          <span className="font-medium">{invoice(sale.invoiceNo)}</span>
          <span>{sale.completedAt?.replace('T', ' ')}</span>
        </div>

        {reversal && (
          <p className="text-sm font-medium text-destructive">
            Pembatalan transaksi {invoice(null)}
          </p>
        )}

        {sale.customerName && (
          <p className="text-sm">
            {sale.customerName}
            {sale.customerPhone ? ` · ${sale.customerPhone}` : ''}
          </p>
        )}

        <table className="w-full text-sm">
          <tbody>
            {sale.lines.map((l, i) => (
              <tr key={i} className="align-top">
                <td className="py-1">
                  {l.name}
                  {l.quantity > 1 && <span className="text-muted-foreground"> ×{l.quantity}</span>}
                  {l.discount !== 0 && (
                    <div className="text-xs text-muted-foreground">
                      Diskon {formatMoney(Math.abs(l.discount), currency)}
                    </div>
                  )}
                </td>
                <td className="py-1 text-right">
                  {formatMoney(l.unitPrice * l.quantity - l.discount, currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <dl className="space-y-1 border-t pt-2 text-sm">
          <div className="flex justify-between">
            <dt>Subtotal</dt><dd>{formatMoney(sale.subtotal, currency)}</dd>
          </div>
          {sale.discount !== 0 && (
            <div className="flex justify-between text-muted-foreground">
              <dt>Diskon</dt><dd>−{formatMoney(Math.abs(sale.discount), currency)}</dd>
            </div>
          )}
          <div className="flex justify-between text-base font-medium">
            <dt>Total</dt><dd>{formatMoney(sale.total, currency)}</dd>
          </div>
          {sale.payments.map((p, i) => (
            <div key={i} className="flex justify-between text-muted-foreground">
              <dt>{METHOD_LABEL[p.method] ?? p.method}</dt>
              <dd>{formatMoney(p.amount, currency)}</dd>
            </div>
          ))}
        </dl>

        <p className="text-center text-xs text-muted-foreground">Terima kasih.</p>
      </article>
    </div>
  )
}

/** The logo route is keyed by slug, because the public booking page uses the
 *  same URL and has no session to resolve an organization from. */
async function salonSlug(organizationId: string) {
  const { db } = await import('@/lib/db')
  const { sql } = await import('drizzle-orm')
  const { rows } = await db.execute(sql`
    select slug from organizations where id = ${organizationId}`)
  return (rows[0] as { slug: string }).slug
}
