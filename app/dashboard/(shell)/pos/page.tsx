import { headers } from 'next/headers'
import { requireBranch, requirePagePermission, requirePageOrg } from '@/lib/session'
import { auth } from '@/lib/auth'
import { bookableServices, getBooking } from '@/lib/booking'
import { getCustomer } from '@/lib/customer'
import { salonSettings } from '@/lib/service'
import { Cart } from './cart'

/**
 * PRD §5.2's checkout. One screen, because §5.2 asks for ≤5 clicks and the
 * cart is form state rather than a stored row (spec 2.4b).
 *
 * `?bookingId=` prefills from the day list -- Flow B's "open the 14:00 booking,
 * checkout".
 */
export default async function PosPage({
  searchParams,
}: {
  searchParams: Promise<{ bookingId?: string }>
}) {
  await requirePagePermission({ pos: ['checkout'] })
  const { organizationId } = await requirePageOrg()
  const { branchId } = await requireBranch()
  const { bookingId } = await searchParams

  const [offers, { currency }] = await Promise.all([
    bookableServices(organizationId, branchId),
    salonSettings(organizationId),
  ])

  // Discount is a separate statement from checkout, so a role may ring up a
  // sale without being able to change what it costs. The action re-checks --
  // this only decides whether the fields are drawn.
  const { success: canDiscount } = await auth.api.hasPermission({
    headers: await headers(),
    body: { permissions: { pos: ['discount'] } },
  })

  const booking = bookingId ? await getBooking(bookingId, organizationId) : null
  const bookingCustomer = booking
    ? await getCustomer(booking.customerId, organizationId)
    : null

  const prefill = booking
    ? {
      items: [{
        serviceId: booking.serviceId,
        name: booking.serviceName,
        price: offers.find((o) => o.serviceId === booking.serviceId)?.price ?? 0,
        quantity: 1,
        discount: 0,
      }],
      name: bookingCustomer?.name ?? booking.customerName,
      phone: bookingCustomer?.phone ?? '',
      customerId: bookingCustomer?.id ?? null,
    }
    : { items: [], name: '', phone: '', customerId: null }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-medium">Kasir</h1>
        {booking && (
          <p className="text-sm text-muted-foreground">
            {booking.customerName} — {booking.serviceName} — {booking.startsAt.slice(11)}
          </p>
        )}
      </div>
      <Cart
        offers={offers}
        currency={currency}
        bookingId={booking?.id ?? null}
        prefill={prefill}
        canDiscount={canDiscount}
      />
    </div>
  )
}
