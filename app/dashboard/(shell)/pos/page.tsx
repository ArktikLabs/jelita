import Link from 'next/link'
import { headers } from 'next/headers'
import { requireBranch, requirePagePermission, requirePageOrg } from '@/lib/session'
import { auth } from '@/lib/auth'
import { bookableServices, getBooking } from '@/lib/booking'
import { getCustomer, listCustomers } from '@/lib/customer'
import { salonSettings } from '@/lib/service'
import { listStaff } from '@/lib/staff'
import { sellableProducts } from '@/lib/inventory'
import { buttonVariants } from '@/components/ui/button'
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
  searchParams: Promise<{ bookingId?: string; customer?: string; q?: string }>
}) {
  await requirePagePermission({ pos: ['checkout'] })
  const { organizationId } = await requirePageOrg()
  const { branchId } = await requireBranch()
  const { bookingId, customer: customerId, q } = await searchParams

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
  // §5.7: "search by name/number from POS for fast lookup at checkout". A GET
  // param rather than a client fetch -- the same two-phase shape the booking
  // form uses, so the result is bookmarkable and there is no second code path.
  const matches = q?.trim() ? await listCustomers(organizationId, { search: q }) : []
  const chosen = customerId ? await getCustomer(customerId, organizationId) : null
  const bookingCustomer = booking
    ? await getCustomer(booking.customerId, organizationId)
    : chosen

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
    : {
      items: [],
      name: chosen?.name ?? '',
      phone: chosen?.phone ?? '',
      customerId: chosen?.id ?? null,
    }

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
      {!booking && (
        <div className="space-y-2 rounded-md border p-3">
          <form className="flex flex-wrap items-end gap-2">
            <div className="space-y-2">
              <label htmlFor="q" className="text-sm font-medium">Cari pelanggan</label>
              <input
                id="q"
                name="q"
                defaultValue={q ?? ''}
                placeholder="Nama atau nomor"
                className="flex h-9 rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs"
              />
            </div>
            <button type="submit" className={buttonVariants({ variant: 'outline' })}>
              Cari
            </button>
          </form>
          {q?.trim() && (
            matches.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Tidak ada yang cocok. Isi nama dan nomor di bawah untuk pelanggan baru.
              </p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {matches.slice(0, 8).map((c) => (
                  <li key={c.id}>
                    <Link
                      href={`/dashboard/pos?customer=${c.id}`}
                      className={buttonVariants({
                        variant: c.id === chosen?.id ? 'default' : 'outline', size: 'sm',
                      })}
                    >
                      {c.name}{c.phone ? ` · ${c.phone}` : ''}
                    </Link>
                  </li>
                ))}
              </ul>
            )
          )}
        </div>
      )}

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
