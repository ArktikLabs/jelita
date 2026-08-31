'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { PlanError, requireQuota } from '@/lib/plan/entitlements'
import { requirePageOrg, requirePagePermission } from '@/lib/session'
import { salonCurrency } from '@/lib/service'
import { parseMoney } from '@/lib/money'
import { formError, type FormState } from '@/lib/form-state'

export async function createServiceAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  await requirePagePermission({ service: ['create'] })
  const { organizationId } = await requirePageOrg()

  const name = String(formData.get('name') ?? '').trim()
  const duration = Number(formData.get('durationMinutes') ?? 0)
  const currency = await salonCurrency(organizationId)
  const price = parseMoney(String(formData.get('price') ?? ''), currency)

  if (!name) return { error: 'Nama layanan wajib diisi.' }
  if (!Number.isInteger(duration) || duration <= 0) {
    return { error: 'Durasi harus lebih dari 0 menit.' }
  }
  if (price === null) return { error: 'Harga tidak valid.' }

  try {
    await requireQuota('services')
    // A categoryId from the client is untrusted, but the composite FK
    // (category_id, organization_id) into service_categories makes a
    // borrowed category unstorable -- see the note in actions.ts's sibling
    // createCategoryAction. Safe only as long as that FK stands.
    const categoryId = String(formData.get('categoryId') ?? '').trim() || null
    await db.execute(sql`
      insert into services (id, organization_id, category_id, name,
                            duration_minutes, price)
      values (${crypto.randomUUID()}, ${organizationId}, ${categoryId},
              ${name}, ${duration}, ${price})`)
  } catch (e) {
    if (e instanceof PlanError) {
      return { error: 'Kuota layanan paket Anda sudah tercapai. Upgrade untuk menambah layanan.' }
    }
    // The unique index on (organization_id, lower(name)) surfaces as a
    // constraint violation -- map it rather than leaking Postgres text.
    // db.execute wraps the driver's error in a DrizzleQueryError whose own
    // .message is "Failed query: ...", not pg's constraint text; the actual
    // "duplicate key value violates unique constraint ..." lives on .cause.
    const pgMessage = e instanceof Error
      ? `${e.message} ${e.cause instanceof Error ? e.cause.message : ''}`
      : ''
    if (/services_org_name_lower/.test(pgMessage)) {
      return { error: 'Layanan dengan nama ini sudah ada.' }
    }
    return { error: formError(e, 'Gagal menambah layanan.') }
  }
  revalidatePath('/services')
  redirect('/services')
}

/**
 * Same guard shape as createServiceAction -- a category is only ever created
 * alongside adding services, so front desk and stylists (service:['read']
 * only) have no path here either. Name-only; deleting a category is out of
 * scope (the on-delete-set-null FK already leaves its services intact).
 */
export async function createCategoryAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  await requirePagePermission({ service: ['create'] })
  const { organizationId } = await requirePageOrg()

  const name = String(formData.get('name') ?? '').trim()
  if (!name) return { error: 'Nama kategori wajib diisi.' }

  try {
    await db.execute(sql`
      insert into service_categories (id, organization_id, name)
      values (${crypto.randomUUID()}, ${organizationId}, ${name})`)
  } catch (e) {
    return { error: formError(e, 'Gagal menambah kategori.') }
  }
  revalidatePath('/services')
  return { done: true }
}
