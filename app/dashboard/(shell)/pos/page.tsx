import { headers } from 'next/headers'
import { requireBranch, requirePagePermission, requirePageOrg } from '@/lib/session'
import { auth } from '@/lib/auth'
import { bookableServices, getBooking } from '@/lib/booking'
import { getCustomer } from '@/lib/customer'
import { salonSettings } from '@/lib/service'
import { listStaff } from '@/lib/staff'
import { sellableProducts } from '@/lib/inventory'
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

  const [services, retail, { currency }, staff] = await Promise.all([
    bookableServices(organizationId, branchId),
    sellableProducts(organizationId, branchId),
    salonSettings(organizationId),
    listStaff(organizationId),
  ])
  // Services and retail products in one list: §5.2's cart holds both, and the
  // cart itself does not care which until it posts.
  const offers = [
    ...services.map((s) => ({
      id: s.serviceId, name: s.name, price: s.price, isProduct: false,
    })),
    ...retail.map((p) => ({
      id: p.id, name: p.name, price: p.price ?? 0, isProduct: true,
    })),
  ]
  // Who a line can be attributed to: active staff at this branch. A line with
  // nobody named earns no commission, which is legitimate.
  const performers = staff
    .filter((s) => s.active && s.teamId === branchId)
    .map((s) => ({ userId: s.userId, name: s.name }))

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
        id: booking.serviceId,
        isProduct: false,
        name: booking.serviceName,
        price: services.find((o) => o.serviceId === booking.serviceId)?.price ?? 0,
        quantity: 1,
        discount: 0,
        // Defaulted from the booking: the stylist who did the work is already
        // known, and making the desk re-pick them is how commissions end up
        // unattributed.
        staffUserId: booking.staffUserId,
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
        performers={performers}
        currency={currency}
        bookingId={booking?.id ?? null}
        prefill={prefill}
        canDiscount={canDiscount}
      />
    </div>
  )
}
