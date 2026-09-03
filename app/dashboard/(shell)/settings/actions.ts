'use server'

import { revalidatePath } from 'next/cache'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { requirePageOrg, requirePagePermission } from '@/lib/session'
import { isCurrencyCode, parseMoney } from '@/lib/money'
import { parsePointsValue } from '@/lib/customer'
import { imageType, logoKey, putObject } from '@/lib/storage'
import { salonSettings } from '@/lib/service'
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

/**
 * Whether the first sale of a new day closes yesterday's till session.
 *
 * Off by default and opt-in: closing is what locks the takings, so a salon
 * should choose to have it happen without anyone deciding it.
 */
export async function setAutoCloseShiftAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  await requirePagePermission({ settings: ['update'] })
  const { organizationId } = await requirePageOrg()
  const on = formData.get('autoCloseShift') === '1'
  await db.execute(sql`
    update salon_profiles set auto_close_shift = ${on}, updated_at = now()
     where organization_id = ${organizationId}`)
  revalidatePath('/dashboard/settings')
  revalidatePath('/dashboard/transactions')
  return { done: true }
}

/**
 * PRD §5.7's points rule, in either shape:
 *
 *   'spend' -- this much spending earns one point (§5.7's own wording)
 *   'visit' -- this many points per transaction, whatever it cost
 *
 * An EMPTY value turns points off, rather than storing zero: a salon not
 * running a loyalty scheme should see no points at all, and zero would read as
 * "you have earned nothing".
 */
export async function setPointsRuleAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  await requirePagePermission({ settings: ['update'] })
  const { organizationId } = await requirePageOrg()
  const { currency } = await salonSettings(organizationId)

  const kind = String(formData.get('pointsKind') ?? '')
  const raw = String(formData.get('pointsValue') ?? '').trim()

  if (raw === '') {
    await db.execute(sql`
      update salon_profiles set points_kind = null, points_value = null, updated_at = now()
       where organization_id = ${organizationId}`)
    revalidatePath('/dashboard/settings')
    return { done: true }
  }
  if (kind !== 'spend' && kind !== 'visit') return { error: 'Jenis poin tidak dikenali.' }

  // In lib/customer.ts with its own test: a visit COUNT must not go through
  // parseMoney, and that mistake is invisible in IDR.
  const value = parsePointsValue(kind, raw, currency)
  if (value === null || value <= 0) {
    return {
      error: kind === 'spend'
        ? 'Nilai belanja per poin harus lebih dari nol.'
        : 'Jumlah poin harus bilangan bulat lebih dari nol.',
    }
  }

  await db.execute(sql`
    update salon_profiles set points_kind = ${kind}, points_value = ${value},
      updated_at = now()
     where organization_id = ${organizationId}`)
  revalidatePath('/dashboard/settings')
  return { done: true }
}

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

/** 200 KB. A salon logo is a header image, not a photograph, and an
 *  unbounded upload endpoint is an unbounded bill. */
const MAX_LOGO_BYTES = 200 * 1024

/**
 * White-label branding (PRD §7). The bytes go to object storage; the row
 * records only that a logo exists and when it changed, which is what busts the
 * cache on /api/salon/logo.
 */
export async function setBrandingAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  await requirePagePermission({ settings: ['update'] })
  const { organizationId } = await requirePageOrg()

  const color = String(formData.get('brandColor') ?? '').trim()
  if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) {
    // Also a check constraint in the database. This one exists to say so in
    // Indonesian rather than as a 500 -- a colour that reaches a stylesheet
    // unvalidated is a CSS injection on the public booking page.
    return { error: 'Warna harus format #rrggbb, misalnya #1a2b3c.' }
  }

  const file = formData.get('logo')
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_LOGO_BYTES) return { error: 'Logo maksimal 200 KB.' }
    const bytes = new Uint8Array(await file.arrayBuffer())
    // The MAGIC BYTES decide, never file.type: that is the browser's label for
    // what the user picked, and a browser sniffs the real content anyway.
    const type = imageType(bytes)
    if (!type) return { error: 'Logo harus PNG, JPEG atau WebP.' }
    await putObject(logoKey(organizationId), bytes, type)
    await db.execute(sql`
      update salon_profiles
         set logo_key = ${logoKey(organizationId)}, logo_updated_at = now(),
             updated_at = now()
       where organization_id = ${organizationId}`)
  }

  await db.execute(sql`
    update salon_profiles set brand_color = ${color || null}, updated_at = now()
     where organization_id = ${organizationId}`)
  revalidatePath('/dashboard/settings')
  return { done: true }
}
