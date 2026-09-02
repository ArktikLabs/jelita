'use server'

import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { createBooking } from '@/lib/booking'
import { findOrCreateByPhone } from '@/lib/customer'
import { normalizePhone } from '@/lib/phone'
import { bookingsTodayFor, resolveBranch, resolveSalon } from '@/lib/salon'
import { type FormState } from '@/lib/form-state'

/**
 * The one write on this product that has no session behind it.
 *
 * Everything it receives is a string a stranger chose, so nothing is trusted:
 * the slug is resolved, the branch is checked against that salon, and
 * createBooking recomputes availability before the exclusion constraint gets
 * the final say.
 */

/**
 * A bored script, not a determined one -- naming the ceiling rather than
 * pretending this is anti-abuse. The real answer is a captcha or WhatsApp
 * verification, and neither is in this slice.
 *
 * ponytail: per-phone daily cap, counted at write time. Upgrade path when it
 * matters: a captcha, or verifying the number before the booking is written.
 */
const DAILY_CAP = 5

/** Deliberately identical for a bad slug, a foreign branch, and a salon with
 *  nothing bookable: a stranger must not be able to tell which, or the error
 *  becomes a directory of which salons exist. */
const NOT_BOOKABLE = { error: 'Salon ini sedang tidak menerima pemesanan online.' }

export async function publicBookAction(
  _prev: FormState, formData: FormData,
): Promise<FormState & { bookedAt?: string }> {
  const salon = await resolveSalon(String(formData.get('salon') ?? ''))
  if (!salon) return NOT_BOOKABLE

  // The branch is validated against THIS salon. Without it,
  // `?cabang=<another salon's branch>` would reach available_slots with a
  // foreign team id -- the composite FKs would refuse the row, but as a
  // constraint error rather than an answer.
  const branch = await resolveBranch(
    salon.organizationId, String(formData.get('teamId') ?? '') || null)
  if (!branch) return NOT_BOOKABLE

  const serviceId = String(formData.get('serviceId') ?? '')
  const startsAt = String(formData.get('startsAt') ?? '')
  const name = String(formData.get('name') ?? '').trim()
  const phone = String(formData.get('phone') ?? '').trim()
  const staffUserId = String(formData.get('staffUserId') ?? '') || null

  if (!serviceId) return { error: 'Pilih layanan dulu.' }
  if (!startsAt) return { error: 'Pilih jam dulu.' }
  if (!name) return { error: 'Nama wajib diisi.' }

  // Normalised here as well as inside findOrCreateByPhone, because the cap is
  // counted on the normalised key -- re-spelling 0812 as +62812 must not buy a
  // fresh allowance.
  const phoneKey = normalizePhone(phone)
  if (!phoneKey) return { error: 'Nomor WhatsApp tidak dikenali. Contoh: 0812xxxxxxx.' }

  const date = startsAt.slice(0, 10)
  if (await bookingsTodayFor(salon.organizationId, phoneKey, date) >= DAILY_CAP) {
    return { error: 'Nomor ini sudah punya banyak janji temu hari itu. Hubungi salon langsung.' }
  }

  const customer = await findOrCreateByPhone(salon.organizationId, { name, phone })

  try {
    await createBooking({
      organizationId: salon.organizationId,
      teamId: branch.teamId,
      serviceId,
      customerId: customer.id,
      date,
      startsAt,
      staffUserId,
      // The salon confirms (spec 2.7). A slot a stranger claimed must not be
      // resold before anyone has looked at it, which is why pending holds it.
      status: 'pending',
    })
  } catch (e) {
    const code = e instanceof Error ? e.message : ''
    if (code === 'SLOT_TAKEN') {
      return { error: 'Jam itu baru saja diambil. Silakan pilih jam lain.' }
    }
    if (code === 'NOT_OFFERED') return NOT_BOOKABLE
    throw e
  }
  return { done: true, bookedAt: startsAt }
}

/** Public read of the salon's own timezone-free "today", for the date field's
 *  lower bound. Kept server-side so the page does not depend on the visitor's
 *  clock, which may be in another zone entirely. */
export async function salonToday(): Promise<string> {
  const { rows } = await db.execute(sql`select to_char(now(), 'YYYY-MM-DD') as d`)
  return (rows[0] as { d: string }).d
}
