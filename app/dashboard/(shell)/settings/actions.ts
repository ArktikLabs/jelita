'use server'

import { revalidatePath } from 'next/cache'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { requirePageOrg, requirePagePermission } from '@/lib/session'
import { isCurrencyCode } from '@/lib/money'
import { type FormState } from '@/lib/form-state'

/**
 * Moved here from /services with the card: currency was always a salon-wide
 * setting living on a catalogue screen because there was nowhere else to put
 * it. The SQL is unchanged -- tests/service.db.test.ts mirrors these exact
 * statements.
 *
 * Guarded by settings:['update'] now, matching the page. That is owner and
 * admin, the same pair service:['update'] admitted, so no role gains or loses
 * access in the move. A public POST endpoint in its own right, so the check
 * lives here too, not only on the page.
 */
export async function setCurrencyAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  await requirePagePermission({ settings: ['update'] })
  const { organizationId } = await requirePageOrg()
  const currency = String(formData.get('currency') ?? '')
  if (!isCurrencyCode(currency)) return { error: 'Mata uang tidak dikenali.' }

  // Spec 2.6: switching currency would reinterpret every stored amount by
  // orders of magnitude -- 50000 rupiah silently reading as 50000 dollars.
  // Re-denominating an operating salon is a data migration, not a settings
  // toggle.
  //
  // TWO statements, ONE transaction -- a single UPDATE with `not exists` in
  // its own WHERE is NOT enough, confirmed by testing raw Postgres locking
  // directly: when this statement blocks on createServiceAction's row lock
  // and then unblocks, Postgres only re-checks the LOCKED ROW's own columns
  // against the concurrent write (EvalPlanQual) -- a `not exists` subquery
  // against a DIFFERENT table (services) still runs against the snapshot
  // this statement started with, so it does not see a service that
  // committed while this was blocked. The first statement below only takes
  // the row lock (serialising against createServiceAction's own lock on the
  // same row); the second is issued FRESH afterward, so it gets a brand new
  // READ COMMITTED snapshot that does see anything committed in the
  // meantime.
  const rowCount = await db.transaction(async (tx) => {
    await tx.execute(sql`
      select 1 from salon_profiles where organization_id = ${organizationId} for update`)
    const result = await tx.execute(sql`
      update salon_profiles set currency = ${currency}, updated_at = now()
       where organization_id = ${organizationId}
         and not exists (select 1 from services where organization_id = ${organizationId})`)
    return result.rowCount
  })
  if (!rowCount) return { error: 'Mata uang tidak dapat diubah setelah ada layanan berharga.' }
  revalidatePath('/dashboard/settings')
  return { done: true }
}

/**
 * The booking grid. Editable at ANY time, unlike currency: a booking stores
 * its own start and end, so changing this changes which slots are offered
 * tomorrow and cannot invalidate what is already booked (spec 2.3).
 *
 * The allow-list is enforced in the database too -- this check gives the user
 * a message instead of a 500, it is not the guarantee.
 */
const SLOT_CHOICES = [15, 20, 30, 45, 60]

export async function setSlotMinutesAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  await requirePagePermission({ settings: ['update'] })
  const { organizationId } = await requirePageOrg()
  const minutes = Number(formData.get('slotMinutes'))
  if (!SLOT_CHOICES.includes(minutes)) return { error: 'Interval jadwal tidak dikenali.' }

  await db.execute(sql`
    update salon_profiles set slot_minutes = ${minutes}, updated_at = now()
     where organization_id = ${organizationId}`)
  revalidatePath('/dashboard/settings')
  revalidatePath('/dashboard/bookings')
  return { done: true }
}
