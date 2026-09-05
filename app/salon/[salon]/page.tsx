import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { bookableBranches, resolveBranch, resolveSalon } from '@/lib/salon'
import { bookableServices } from '@/lib/booking'
import { salonSettings } from '@/lib/service'
import { formatMoney, type CurrencyCode } from '@/lib/money'
import { buttonVariants } from '@/components/ui/button'

const DAYS = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu']

/**
 * The salon's shopfront -- what a tenant subdomain serves at its root.
 *
 * Everything here is data the salon already maintains for the app to work, so
 * the page cannot go stale: the menu is the same `service_branch_pricing` view
 * the booking form reads, and the hours are the ones availability is computed
 * from. A shopfront that disagrees with the booking engine would be worse than
 * no shopfront.
 */
export async function generateMetadata(
  { params }: { params: Promise<{ salon: string }> },
): Promise<Metadata> {
  const { salon: slug } = await params
  const salon = await resolveSalon(slug)
  if (!salon) return {}
  const [branch] = await bookableBranches(salon.organizationId)
  return {
    title: salon.name,
    // A link pasted into WhatsApp previewed as "Jelita Salon Suite" before
    // this -- the platform's name, on the salon's own page.
    description: branch?.address ?? `Pesan janji temu di ${salon.name}.`,
  }
}

export default async function SalonLandingPage({
  params, searchParams,
}: {
  params: Promise<{ salon: string }>
  searchParams: Promise<{ cabang?: string }>
}) {
  const { salon: slug } = await params
  const salon = await resolveSalon(slug)
  // Same 404 the booking page gives an unknown slug: a public page must not
  // let a stranger tell "no such salon" from "not taking bookings", or the
  // 404 becomes a directory of which salons exist.
  if (!salon) notFound()

  const { cabang } = await searchParams
  const [branches, settings] = await Promise.all([
    bookableBranches(salon.organizationId),
    salonSettings(salon.organizationId),
  ])

  // The SAME resolution the booking page uses, not a second lookup: it is what
  // refuses `?cabang=<another salon's branch>`.
  const chosen = cabang
    ? await resolveBranch(cabang, salon.organizationId)
    : null
  if (cabang && !chosen) notFound()
  const branch = chosen ?? branches[0] ?? null

  const services = branch
    ? await bookableServices(salon.organizationId, branch.teamId)
    : []
  const currency = settings.currency as CurrencyCode

  // Grouped in the page, from one ordered query, so the menu and the booking
  // form cannot disagree about what is offered or what it costs.
  const menu = new Map<string, typeof services>()
  for (const s of services) {
    const key = s.category ?? 'Lainnya'
    menu.set(key, [...(menu.get(key) ?? []), s])
  }

  const bookHref = (extra = '') =>
    `/book/${slug}${extra}`
  const today = new Date().getDay()

  return (
    <main className="mx-auto max-w-3xl space-y-10 p-6">
      <header className="space-y-4 text-center">
        {settings.hasLogo && (
          // Served through /api/salon/logo keyed by SLUG, never a bucket URL --
          // the same route the booking page uses.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/salon/logo?salon=${slug}&v=${settings.logoVersion}`}
            alt={salon.name}
            className="mx-auto h-20 w-20 rounded-full object-cover"
          />
        )}
        <h1
          className="text-3xl font-semibold"
          style={settings.brandColor ? { color: settings.brandColor } : undefined}
        >
          {salon.name}
        </h1>
        <Link
          href={bookHref(branch ? `?cabang=${branch.teamId}` : '')}
          className={buttonVariants({ size: 'lg' })}
        >
          Pesan sekarang
        </Link>
      </header>

      {branches.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-lg font-medium">Cabang</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {branches.map((b) => (
              <div
                key={b.teamId}
                className={`space-y-2 rounded-lg border p-4 ${
                  branch?.teamId === b.teamId ? 'border-foreground' : ''
                }`}
              >
                <div className="font-medium">{b.name}</div>
                {b.address && <p className="text-sm text-muted-foreground">{b.address}</p>}
                {b.phone && <p className="text-sm text-muted-foreground">{b.phone}</p>}
                <ul className="space-y-0.5 text-sm">
                  {b.hours.map((h) => (
                    <li
                      key={h.weekday}
                      /* Today emphasised: "are they open now" is the question
                         a visitor actually has. */
                      className={h.weekday === today ? 'font-medium' : 'text-muted-foreground'}
                    >
                      {DAYS[h.weekday]}: {h.closed ? 'Tutup' : `${h.opensAt}–${h.closesAt}`}
                    </li>
                  ))}
                </ul>
                {branches.length > 1 && branch?.teamId !== b.teamId && (
                  <Link
                    href={`?cabang=${b.teamId}`}
                    className={buttonVariants({ variant: 'outline', size: 'sm' })}
                  >
                    Lihat harga cabang ini
                  </Link>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {branch && services.length > 0 && (
        <section className="space-y-4">
          {/* Named, always. Prices are per branch, so a two-branch salon
              would otherwise advertise one branch's prices as the salon's. */}
          <h2 className="text-lg font-medium">Layanan — {branch.name}</h2>
          {[...menu.entries()].map(([category, items]) => (
            <div key={category} className="space-y-1">
              <h3 className="text-sm font-medium text-muted-foreground">{category}</h3>
              <ul className="divide-y rounded-lg border">
                {items.map((s) => (
                  <li key={s.serviceId}>
                    {/* The row IS the booking link. A landing page whose only
                        action is "Book now" has added a step, not removed one. */}
                    <Link
                      href={bookHref(`?serviceId=${s.serviceId}&cabang=${branch.teamId}`)}
                      className="flex items-center justify-between gap-4 p-3 hover:bg-muted"
                    >
                      <span>
                        {s.name}
                        <span className="ml-2 text-sm text-muted-foreground">
                          {s.durationMinutes} menit
                        </span>
                      </span>
                      <span className="shrink-0 font-medium">
                        {formatMoney(s.price, currency)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      <footer className="border-t pt-6 text-center text-sm text-muted-foreground">
        Ditenagai <Link href="/" className="underline">Jelita</Link>
      </footer>
    </main>
  )
}
