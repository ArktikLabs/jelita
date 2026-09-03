import { notFound } from 'next/navigation'
import { bookableBranches, resolveBranch, resolveSalon } from '@/lib/salon'
import { salonSettings } from '@/lib/service'
import { bookableServices, listSlots, slotTimes } from '@/lib/booking'
import { listPerformers } from '@/lib/service'
import { formatMoney, type CurrencyCode } from '@/lib/money'
import { Label } from '@/components/ui/label'
import { buttonVariants } from '@/components/ui/button'
import { BookForm } from './book-form'
import { salonToday } from './actions'

const inputClass = 'flex h-9 rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs'

/**
 * The public booking page. No session, no login, no cookie -- which is why the
 * tenant subdomain never needs one and the dashboard can stay on the apex
 * (spec 2.3).
 *
 * Reached as `ovarya.<apex>/book`, rewritten by next.config.ts to this route
 * with `salon` as an ordinary param. The hostname only says which salon to
 * LOOK UP; lib/salon.ts is what validates, and the action resolves everything
 * again for itself.
 *
 * Two phases, both plain forms, the same shape the internal form uses -- so
 * createBooking stays the single authority and the exclusion constraint is
 * still the arbiter.
 */
export default async function PublicBookingPage({
  params, searchParams,
}: {
  params: Promise<{ salon: string }>
  searchParams: Promise<{ cabang?: string; serviceId?: string; staffUserId?: string; date?: string }>
}) {
  const { salon: slug } = await params
  const salon = await resolveSalon(slug)
  // notFound, not a message: a page that says "no such salon" is a directory
  // of which salons exist.
  if (!salon) notFound()

  const q = await searchParams
  const settings = await salonSettings(salon.organizationId)
  const brand = {
    color: settings.brandColor,
    logoUrl: settings.hasLogo
      ? `/api/salon/logo?salon=${slug}&v=${settings.logoVersion}`
      : null,
  }
  const branches = await bookableBranches(salon.organizationId)
  // With exactly one bookable branch the choice is implicit -- free and
  // starter tiers cap branches at 1, so most salons never see this step.
  const branch = await resolveBranch(salon.organizationId, q.cabang ?? null)

  if (branches.length === 0) {
    return (
      <Shell title={salon.name} brand={brand}>
        <p className="text-sm text-muted-foreground">
          Salon ini sedang tidak menerima pemesanan online.
        </p>
      </Shell>
    )
  }

  if (!branch) {
    return (
      <Shell title={salon.name} brand={brand}>
        <h2 className="text-sm font-medium">Pilih cabang</h2>
        <ul className="space-y-2">
          {branches.map((b) => (
            <li key={b.teamId}>
              <a
                href={`?cabang=${b.teamId}`}
                className={buttonVariants({ variant: 'outline' })}
              >
                {b.name}{b.address ? ` — ${b.address}` : ''}
              </a>
            </li>
          ))}
        </ul>
      </Shell>
    )
  }

  const today = await salonToday()
  const services = await bookableServices(salon.organizationId, branch.teamId)
  const serviceId = services.some((s) => s.serviceId === q.serviceId) ? q.serviceId! : ''
  const service = services.find((s) => s.serviceId === serviceId)
  const date = /^\d{4}-\d{2}-\d{2}$/.test(q.date ?? '') ? q.date! : today

  const performers = serviceId
    ? (await listPerformers(serviceId, salon.organizationId))
      .filter((p) => p.linked && p.teamId === branch.teamId)
    : []
  const staffUserId = performers.some((p) => p.userId === q.staffUserId) ? q.staffUserId! : ''

  const slots = serviceId
    ? slotTimes(await listSlots({
      organizationId: salon.organizationId, teamId: branch.teamId, serviceId, date,
      staffUserId: staffUserId || null,
    }))
    : []

  const chosen = performers.find((p) => p.userId === staffUserId)
  const summary = [
    service?.name, branch.name, chosen ? chosen.name : 'siapa saja',
  ].filter(Boolean).join(' · ')

  return (
    <Shell title={salon.name} subtitle={branch.name} brand={brand}>
      <form className="flex flex-wrap items-end gap-2">
        {/* Carried forward so choosing a service does not lose the branch. */}
        <input type="hidden" name="cabang" value={branch.teamId} />
        <div className="space-y-2">
          <Label htmlFor="serviceId">Layanan</Label>
          <select id="serviceId" name="serviceId" defaultValue={serviceId} className={inputClass}>
            <option value="">Pilih layanan</option>
            {services.map((s) => (
              <option key={s.serviceId} value={s.serviceId}>
                {s.name} — {s.durationMinutes} menit —{' '}
                {formatMoney(s.price, s.currency as CurrencyCode)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="staffUserId">Staf</Label>
          <select id="staffUserId" name="staffUserId" defaultValue={staffUserId} className={inputClass}>
            <option value="">Siapa saja</option>
            {performers.map((p) => (
              <option key={p.userId} value={p.userId}>{p.name}</option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="date">Tanggal</Label>
          <input id="date" type="date" name="date" min={today} defaultValue={date} className={inputClass} />
        </div>
        <button type="submit" className={buttonVariants({ variant: 'outline' })}>
          Lihat jadwal
        </button>
      </form>

      {!serviceId ? (
        <p className="text-sm text-muted-foreground">
          Pilih layanan dulu untuk melihat jam yang tersedia.
        </p>
      ) : slots.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Tidak ada jam tersedia untuk pilihan itu.
        </p>
      ) : (
        <BookForm
          salon={slug}
          teamId={branch.teamId}
          serviceId={serviceId}
          staffUserId={staffUserId}
          slots={slots}
          summary={summary}
        />
      )}
    </Shell>
  )
}

/**
 * PRD §8: the public page is "brand-colored". The colour is validated
 * `#rrggbb` at both the form and a check constraint, so it can safely reach a
 * style attribute -- an unvalidated one here would be a CSS injection on a
 * page anyone can load.
 */
function Shell({
  title, subtitle, children, brand, logo,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
  brand?: { color: string | null; logoUrl: string | null }
  logo?: string
}) {
  return (
    <main className="mx-auto max-w-2xl space-y-6 p-6">
      <div className="space-y-2">
        {brand?.logoUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={brand.logoUrl} alt="" className="h-12 w-auto" />
        )}
        <h1
          className="text-xl font-medium"
          style={brand?.color ? { color: brand.color } : undefined}
        >
          {title}
        </h1>
        {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {children}
    </main>
  )
}
