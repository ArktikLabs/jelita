import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requirePagePermission, requirePageOrg } from '@/lib/session'
import { getBooking, listSlots, slotTimes } from '@/lib/booking'
import { listPerformers } from '@/lib/service'
import { buttonVariants } from '@/components/ui/button'
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card'
import { RescheduleForm } from './reschedule-form'

/**
 * PRD 5.1's "reschedule via edit form" -- drag-and-drop is post-MVP.
 *
 * The branch is the BOOKING's, not the session's: a booking made at another
 * branch must not be silently moved to whichever one the user has active.
 * getBooking is org-scoped, so that is still a tenant-safe read.
 */
export default async function RescheduleBookingPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ date?: string }>
}) {
  await requirePagePermission({ booking: ['reschedule'] })
  const { organizationId } = await requirePageOrg()
  const { id } = await params
  const booking = await getBooking(id, organizationId)
  if (!booking) notFound()

  const { date: raw } = await searchParams
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw ?? '') ? raw! : booking.startsAt.slice(0, 10)

  const performers = (await listPerformers(booking.serviceId, organizationId))
    .filter((p) => p.linked && p.teamId === booking.teamId)

  const movable = ['pending', 'confirmed'].includes(booking.status)
  const slots = movable
    ? slotTimes(await listSlots({
      organizationId,
      teamId: booking.teamId,
      serviceId: booking.serviceId,
      date,
      staffUserId: booking.staffUserId,
      // Its own row must not count as busy, or every nearby time reads as
      // taken and the booking cannot move by half an hour.
      excludeBookingId: booking.id,
    }))
    : []

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-medium">Pindahkan jadwal</h1>
        <Link
          href={`/dashboard/bookings?date=${booking.startsAt.slice(0, 10)}`}
          className={buttonVariants({ variant: 'outline' })}
        >
          Kembali
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{booking.customerName}</CardTitle>
          <CardDescription>
            {booking.serviceName} — {booking.durationMinutes} menit — sekarang{' '}
            {booking.startsAt.slice(0, 10)} pukul {booking.startsAt.slice(11)}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!movable ? (
            <p className="text-sm text-muted-foreground">
              Janji temu ini sudah selesai atau dibatalkan, jadi tidak bisa dipindahkan.
            </p>
          ) : (
            <>
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
                  Lihat jadwal
                </button>
              </form>

              {slots.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Tidak ada jam tersedia pada tanggal itu.
                </p>
              ) : (
                <RescheduleForm
                  id={booking.id}
                  slots={slots}
                  performers={performers}
                  staffUserId={booking.staffUserId}
                />
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
