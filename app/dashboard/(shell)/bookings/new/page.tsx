import Link from 'next/link'
import { requirePagePermission, requirePageOrg, requireBranch } from '@/lib/session'
import { bookableServices, listSlots, slotTimes } from '@/lib/booking'
import { listPerformers } from '@/lib/service'
import { buttonVariants } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { BookingForm } from './booking-form'

const todayLocal = () => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const inputClass =
  'flex h-9 rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs'

/**
 * Two phases in one page, both plain forms.
 *
 * The first is a GET: choosing a service, a stylist (or "any available") and a
 * date re-renders this page with the slots for them. The second is the POST
 * that books one. Keeping phase one in the query string means no client fetch,
 * no API route, and a bookmarkable day -- and the slot list is always computed
 * by the same server code the create path re-checks against.
 */
export default async function NewBookingPage({
  searchParams,
}: {
  searchParams: Promise<{ serviceId?: string; staffUserId?: string; date?: string }>
}) {
  await requirePagePermission({ booking: ['create'] })
  const { organizationId } = await requirePageOrg()
  const { branchId } = await requireBranch()
  const params = await searchParams

  const services = await bookableServices(organizationId, branchId)
  const serviceId = services.some((s) => s.serviceId === params.serviceId)
    ? params.serviceId!
    : ''
  const date = /^\d{4}-\d{2}-\d{2}$/.test(params.date ?? '')
    ? params.date!
    : todayLocal()

  // Only the people linked to this service AT THIS BRANCH can take it, which
  // is the same set available_slots fans out across.
  const performers = serviceId
    ? (await listPerformers(serviceId, organizationId))
      .filter((p) => p.linked && p.teamId === branchId)
    : []
  const staffUserId = performers.some((p) => p.userId === params.staffUserId)
    ? params.staffUserId!
    : ''

  const slots = serviceId
    ? slotTimes(await listSlots({
      organizationId, teamId: branchId, serviceId, date,
      staffUserId: staffUserId || null,
    }))
    : []

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-medium">Buat janji temu</h1>
        <Link href="/dashboard/bookings" className={buttonVariants({ variant: 'outline' })}>
          Kembali
        </Link>
      </div>

      <form className="flex flex-wrap items-end gap-2">
        <div className="space-y-2">
          <Label htmlFor="serviceId">Layanan</Label>
          <select id="serviceId" name="serviceId" defaultValue={serviceId} className={inputClass}>
            <option value="">Pilih layanan</option>
            {services.map((s) => (
              <option key={s.serviceId} value={s.serviceId}>
                {s.name} — {s.durationMinutes} menit
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="staffUserId">Staf</Label>
          <select id="staffUserId" name="staffUserId" defaultValue={staffUserId} className={inputClass}>
            {/* Absence of a choice, not a value -- assigned at booking time to
                the least-booked stylist who is free then (spec 2.4). */}
            <option value="">Siapa saja</option>
            {performers.map((p) => (
              <option key={p.userId} value={p.userId}>{p.name}</option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="date">Tanggal</Label>
          <input id="date" type="date" name="date" defaultValue={date} className={inputClass} />
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
        <BookingForm serviceId={serviceId} staffUserId={staffUserId} slots={slots} />
      )}
    </div>
  )
}
