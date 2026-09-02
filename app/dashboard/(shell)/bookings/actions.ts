'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireBranch } from '@/lib/session'
import { requirePagePermission } from '@/lib/session'
import { createBooking, setBookingStatus } from '@/lib/booking'
import { findOrCreateByPhone } from '@/lib/customer'
import { type FormState } from '@/lib/form-state'

/**
 * The branch comes from the SESSION, never the form: a posted team_id would
 * let a front-desk user book into a branch they cannot switch to. `write:true`
 * also refuses a closed or over-cap branch, same as every other mutation here.
 */
export async function createBookingAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  await requirePagePermission({ booking: ['create'] })
  const { organizationId, branchId } = await requireBranch({ write: true })
  if (!organizationId) return { error: 'Tidak ada salon aktif.' }

  const serviceId = String(formData.get('serviceId') ?? '')
  const startsAt = String(formData.get('startsAt') ?? '')
  const name = String(formData.get('name') ?? '').trim()
  const phone = String(formData.get('phone') ?? '').trim()
  // The empty option is "any available" -- absence of a choice, not a value.
  const staffUserId = String(formData.get('staffUserId') ?? '') || null
  const note = String(formData.get('note') ?? '').trim() || null

  if (!serviceId) return { error: 'Pilih layanan dulu.' }
  if (!startsAt) return { error: 'Pilih jam dulu.' }
  if (!name) return { error: 'Nama pelanggan wajib diisi.' }

  let customerId: string
  try {
    // Routed through the shared lookup rather than an insert here: two dedup
    // rules that disagree split one person's history in half.
    customerId = (await findOrCreateByPhone(organizationId, { name, phone })).id
  } catch {
    return { error: 'Nomor telepon tidak dikenali. Contoh: 0812xxxxxxx.' }
  }

  const date = startsAt.slice(0, 10)
  try {
    await createBooking({
      organizationId, teamId: branchId, serviceId, customerId,
      date, startsAt, staffUserId, note,
    })
  } catch (e) {
    const code = e instanceof Error ? e.message : ''
    if (code === 'SLOT_TAKEN') {
      return { error: 'Jam itu sudah tidak tersedia. Silakan pilih jam lain.' }
    }
    if (code === 'NOT_OFFERED') {
      return { error: 'Layanan ini tidak tersedia di cabang aktif.' }
    }
    throw e
  }
  revalidatePath('/dashboard/bookings')
  redirect(`/dashboard/bookings?date=${date}`)
}

export async function setBookingStatusAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  await requirePagePermission({ booking: ['update'] })
  const { organizationId } = await requireBranch({ write: true })
  if (!organizationId) return { error: 'Tidak ada salon aktif.' }

  const id = String(formData.get('id') ?? '')
  const status = String(formData.get('status') ?? '')
  try {
    await setBookingStatus(id, organizationId, status)
  } catch (e) {
    const code = e instanceof Error ? e.message : ''
    // Both mean the same thing to the front desk: someone already moved it.
    if (code === 'BAD_TRANSITION' || code === 'BAD_STATUS') {
      return { error: 'Status itu tidak bisa dipakai untuk janji temu ini.' }
    }
    throw e
  }
  revalidatePath('/dashboard/bookings')
  return { done: true }
}
