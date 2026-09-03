'use client'

import { useActionState, useState } from 'react'
import { checkoutAction } from './actions'
import type { FormState } from '@/lib/form-state'
import { formatMoney, type CurrencyCode } from '@/lib/money'
import { PAYMENT_METHODS } from '@/lib/payment'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'

const initial: FormState = {}

type Offer = { serviceId: string; name: string; price: number; currency: string }
type Performer = { userId: string; name: string }
type Item = {
  serviceId: string; name: string; price: number; quantity: number; discount: number
  /** Who performed it. Drives the commission record; empty earns nothing,
   *  which is legitimate for a sale nobody worked on. */
  staffUserId: string
}

const METHOD_LABEL: Record<string, string> = {
  cash: 'Tunai', transfer: 'Transfer', qris: 'QRIS', debit: 'Debit', credit: 'Kredit',
}

/**
 * The cart is STATE HERE, not a row in the database (spec 2.4b): an abandoned
 * open transaction would block its booking from ever being charged, and a
 * cart that only exists in this component cannot be abandoned.
 *
 * Prices are shown from what the server sent and posted back only as service
 * ids and quantities -- lib/pos.ts resolves the price again. Nothing about
 * money that arrives from this component is trusted.
 */
export function Cart({
  offers, performers, currency, bookingId, prefill, canDiscount,
}: {
  offers: Offer[]
  performers: Performer[]
  currency: CurrencyCode
  bookingId: string | null
  prefill: { items: Item[]; name: string; phone: string; customerId: string | null }
  canDiscount: boolean
}) {
  const [state, action, pending] = useActionState(checkoutAction, initial)
  const [items, setItems] = useState<Item[]>(prefill.items)
  const [discount, setDiscount] = useState(0)

  const add = (serviceId: string) => {
    const o = offers.find((x) => x.serviceId === serviceId)
    if (!o) return
    setItems((cur) => {
      const at = cur.findIndex((i) => i.serviceId === serviceId)
      if (at < 0) {
        return [...cur, {
          serviceId, name: o.name, price: o.price, quantity: 1, discount: 0, staffUserId: '',
        }]
      }
      return cur.map((i, n) => (n === at ? { ...i, quantity: i.quantity + 1 } : i))
    })
  }

  const subtotal = items.reduce((n, i) => n + i.price * i.quantity, 0)
  const lineDiscounts = items.reduce((n, i) => n + i.discount, 0)
  const total = Math.max(0, subtotal - lineDiscounts - discount)

  return (
    <form action={action} className="space-y-4">
      {bookingId && <input type="hidden" name="bookingId" value={bookingId} />}
      {prefill.customerId && (
        <input type="hidden" name="customerId" value={prefill.customerId} />
      )}
      {/* One field, because the cart is form state. The server re-prices every
          line from service_branch_pricing regardless of what lands here. */}
      <input
        type="hidden"
        name="items"
        value={JSON.stringify(items.map((i) => ({
          serviceId: i.serviceId, quantity: i.quantity, discount: i.discount,
          staffUserId: i.staffUserId || null,
        })))}
      />
      <input type="hidden" name="discount" value={discount} />

      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        <Label htmlFor="add">Tambah layanan</Label>
        <select
          id="add"
          value=""
          onChange={(e) => add(e.target.value)}
          className="flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs"
        >
          <option value="">Pilih layanan…</option>
          {offers.map((o) => (
            <option key={o.serviceId} value={o.serviceId}>
              {o.name} — {formatMoney(o.price, currency)}
            </option>
          ))}
        </select>
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Keranjang masih kosong.</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {items.map((i, n) => (
            <li key={i.serviceId} className="flex flex-wrap items-center gap-2 p-2 text-sm">
              <span className="flex-1 font-medium">{i.name}</span>
              <select
                aria-label={`Staf ${i.name}`}
                value={i.staffUserId}
                onChange={(e) => setItems((cur) => cur.map((x, m) =>
                  (m === n ? { ...x, staffUserId: e.target.value } : x)))}
                className="h-8 rounded-md border bg-transparent px-2"
              >
                <option value="">Tanpa staf</option>
                {performers.map((p) => (
                  <option key={p.userId} value={p.userId}>{p.name}</option>
                ))}
              </select>
              <input
                type="number"
                min={1}
                aria-label={`Jumlah ${i.name}`}
                value={i.quantity}
                onChange={(e) => setItems((cur) => cur.map((x, m) =>
                  (m === n ? { ...x, quantity: Math.max(1, Number(e.target.value) || 1) } : x)))}
                className="h-8 w-16 rounded-md border bg-transparent px-2"
              />
              {canDiscount && (
                <input
                  type="number"
                  min={0}
                  aria-label={`Diskon ${i.name}`}
                  value={i.discount}
                  onChange={(e) => setItems((cur) => cur.map((x, m) =>
                    (m === n ? { ...x, discount: Math.max(0, Number(e.target.value) || 0) } : x)))}
                  className="h-8 w-28 rounded-md border bg-transparent px-2"
                />
              )}
              <span className="w-28 text-right">
                {formatMoney(i.price * i.quantity - i.discount, currency)}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setItems((cur) => cur.filter((_, m) => m !== n))}
              >
                Hapus
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="name">Nama pelanggan</Label>
          <Input id="name" name="name" defaultValue={prefill.name} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="phone">Nomor WhatsApp</Label>
          <Input id="phone" name="phone" defaultValue={prefill.phone} placeholder="opsional" />
        </div>
      </div>

      {canDiscount && (
        <div className="space-y-2">
          <Label htmlFor="orderDiscount">Diskon transaksi</Label>
          <input
            id="orderDiscount"
            type="number"
            min={0}
            value={discount}
            onChange={(e) => setDiscount(Math.max(0, Number(e.target.value) || 0))}
            className="flex h-9 rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs"
          />
        </div>
      )}

      <dl className="space-y-1 border-t pt-3 text-sm">
        <div className="flex justify-between">
          <dt>Subtotal</dt><dd>{formatMoney(subtotal, currency)}</dd>
        </div>
        <div className="flex justify-between text-muted-foreground">
          <dt>Diskon</dt><dd>−{formatMoney(lineDiscounts + discount, currency)}</dd>
        </div>
        <div className="flex justify-between text-base font-medium">
          <dt>Total</dt><dd data-testid="cart-total">{formatMoney(total, currency)}</dd>
        </div>
      </dl>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Pembayaran</legend>
        <div className="flex flex-wrap gap-2">
          {PAYMENT_METHODS.map((m, i) => (
            <label key={m} className="flex items-center gap-1 rounded-md border px-2 py-1 text-sm">
              <input type="radio" name="method" value={m} defaultChecked={i === 0} required />
              {METHOD_LABEL[m]}
            </label>
          ))}
        </div>
      </fieldset>

      <Button type="submit" disabled={pending || items.length === 0}>
        {pending ? 'Memproses…' : 'Selesaikan pembayaran'}
      </Button>
    </form>
  )
}
