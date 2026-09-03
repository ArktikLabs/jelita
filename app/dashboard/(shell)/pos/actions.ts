'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireBranch, requirePagePermission } from '@/lib/session'
import { checkout, closeShift, voidSale, type CartItem } from '@/lib/pos'
import { findOrCreateByPhone } from '@/lib/customer'
import { isPaymentMethod } from '@/lib/payment'
import { auth } from '@/lib/auth'
import { headers } from 'next/headers'
import { type FormState } from '@/lib/form-state'

/**
 * The cart arrives as JSON in one field, because it is form state rather than
 * a stored row (spec 2.4b) -- there is nothing on the server to add an item
 * to until the sale is rung up.
 *
 * Every price is resolved server-side by lib/pos.ts. What arrives here is only
 * WHICH services, HOW MANY, and how much was taken off.
 */
export async function checkoutAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  const session = await requirePagePermission({ pos: ['checkout'] })
  const { organizationId, branchId } = await requireBranch({ write: true })
  if (!organizationId) return { error: 'Tidak ada salon aktif.' }

  let items: CartItem[]
  try {
    items = JSON.parse(String(formData.get('items') ?? '[]')) as CartItem[]
  } catch {
    return { error: 'Keranjang tidak terbaca.' }
  }
  if (!Array.isArray(items) || items.length === 0) return { error: 'Keranjang masih kosong.' }

  const method = String(formData.get('method') ?? '')
  if (!isPaymentMethod(method)) return { error: 'Metode pembayaran tidak dikenali.' }

  const discount = Number(formData.get('discount') ?? 0) || 0
  const lineDiscounts = items.reduce((n, i) => n + (Number(i.discount) || 0), 0)
  // pos:['discount'] is a separate statement from pos:['checkout'] for exactly
  // this: a role that may ring up a sale need not be allowed to change what it
  // costs. Checked server-side, because hiding the field is not a guard.
  if (discount + lineDiscounts > 0) {
    const { success } = await auth.api.hasPermission({
      headers: await headers(),
      body: { permissions: { pos: ['discount'] } },
    })
    if (!success) return { error: 'Peran ini tidak boleh memberi diskon.' }
  }

  const bookingId = String(formData.get('bookingId') ?? '') || null
  const name = String(formData.get('name') ?? '').trim()
  const phone = String(formData.get('phone') ?? '').trim()
  let customerId = String(formData.get('customerId') ?? '') || null
  // A direct sale need not name anyone (spec 2.5 answer): those sales simply
  // contribute nothing to member history.
  if (!customerId && phone) {
    try {
      customerId = (await findOrCreateByPhone(organizationId, { name: name || phone, phone })).id
    } catch {
      return { error: 'Nomor telepon tidak dikenali. Contoh: 0812xxxxxxx.' }
    }
  }

  let id: string
  try {
    ({ id } = await checkout({
      organizationId, teamId: branchId, userId: session.user.id,
      items, customerId, bookingId, method,
      discount: Number.isFinite(discount) ? discount : 0,
    }))
  } catch (e) {
    const code = e instanceof Error ? e.message : ''
    if (code === 'ALREADY_CHARGED') return { error: 'Janji temu ini sudah dibayar.' }
    if (code === 'NOT_OFFERED') return { error: 'Ada layanan yang tidak tersedia di cabang ini.' }
    if (code === 'BAD_DISCOUNT') return { error: 'Diskon melebihi total.' }
    if (code === 'EMPTY_CART') return { error: 'Keranjang masih kosong.' }
    throw e
  }
  revalidatePath('/dashboard/transactions')
  revalidatePath('/dashboard/bookings')
  redirect(`/dashboard/transactions/${id}`)
}

export async function voidSaleAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  // pos:['void'] -- owner and admin only. Front desk holds checkout and
  // discount and deliberately not this (lib/permissions.ts).
  await requirePagePermission({ pos: ['void'] })
  const { organizationId } = await requireBranch({ write: true })
  if (!organizationId) return { error: 'Tidak ada salon aktif.' }

  try {
    await voidSale(String(formData.get('id') ?? ''), organizationId)
  } catch (e) {
    const code = e instanceof Error ? e.message : ''
    if (code === 'SHIFT_CLOSED') {
      return { error: 'Shift sudah ditutup, jadi transaksi ini tidak bisa dibatalkan.' }
    }
    if (code === 'NOT_VOIDABLE') return { error: 'Transaksi ini tidak bisa dibatalkan.' }
    if (code === 'NOT_FOUND') return { error: 'Transaksi tidak ditemukan.' }
    throw e
  }
  revalidatePath('/dashboard/transactions')
  return { done: true }
}

export async function closeShiftAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  const session = await requirePagePermission({ pos: ['checkout'] })
  const { organizationId } = await requireBranch({ write: true })
  if (!organizationId) return { error: 'Tidak ada salon aktif.' }

  try {
    await closeShift(String(formData.get('id') ?? ''), organizationId, session.user.id)
  } catch {
    return { error: 'Shift itu sudah ditutup.' }
  }
  revalidatePath('/dashboard/transactions')
  return { done: true }
}
