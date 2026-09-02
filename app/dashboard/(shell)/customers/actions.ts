'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { normalizePhone } from '@/lib/phone'
import { getCustomer } from '@/lib/customer'
import { requirePageOrg, requirePagePermission } from '@/lib/session'
import { formError, type FormState } from '@/lib/form-state'

const DUPLICATE = 'Nomor ini sudah terdaftar untuk pelanggan lain.'

/** The unique-index violation, whether drizzle wrapped it or not. */
const isDuplicatePhone = (e: unknown) => {
  const text = [
    e instanceof Error ? e.message : '',
    e instanceof Error && e.cause instanceof Error ? e.cause.message : '',
  ].join(' ')
  return /customers_org_phone_key/.test(text)
}

function readForm(formData: FormData) {
  const name = String(formData.get('name') ?? '').trim()
  const phoneRaw = String(formData.get('phone') ?? '').trim()
  const notes = String(formData.get('notes') ?? '').trim() || null
  return { name, phone: phoneRaw || null, phoneKey: phoneRaw ? normalizePhone(phoneRaw) : null, notes }
}

export async function createCustomerAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  await requirePagePermission({ customer: ['create'] })
  const { organizationId } = await requirePageOrg()
  const { name, phone, phoneKey, notes } = readForm(formData)

  if (!name) return { error: 'Nama pelanggan wajib diisi.' }
  // A phone that is present but has no digits at all is a typo, not an
  // intentional blank -- storing it would make the customer unfindable by
  // number while looking as though they had one.
  if (phone && !phoneKey) return { error: 'Nomor tidak valid.' }

  try {
    await db.execute(sql`
      insert into customers (id, organization_id, name, phone, phone_key, notes)
      values (${crypto.randomUUID()}, ${organizationId}, ${name}, ${phone},
              ${phoneKey}, ${notes})`)
  } catch (e) {
    if (isDuplicatePhone(e)) return { error: DUPLICATE }
    return { error: formError(e, 'Gagal menambah pelanggan.') }
  }
  revalidatePath('/dashboard/customers')
  redirect('/dashboard/customers')
}

export async function updateCustomerAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  await requirePagePermission({ customer: ['update'] })
  const { organizationId } = await requirePageOrg()
  const id = String(formData.get('customerId') ?? '')
  const { name, phone, phoneKey, notes } = readForm(formData)

  if (!(await getCustomer(id, organizationId))) return { error: 'Pelanggan tidak ditemukan.' }
  if (!name) return { error: 'Nama pelanggan wajib diisi.' }
  if (phone && !phoneKey) return { error: 'Nomor tidak valid.' }

  try {
    await db.execute(sql`
      update customers set name = ${name}, phone = ${phone},
             phone_key = ${phoneKey}, notes = ${notes}, updated_at = now()
       where id = ${id} and organization_id = ${organizationId}`)
  } catch (e) {
    if (isDuplicatePhone(e)) return { error: DUPLICATE }
    return { error: formError(e, 'Gagal menyimpan pelanggan.') }
  }
  revalidatePath('/dashboard/customers')
  revalidatePath(`/dashboard/customers/${id}`)
  return { done: true }
}

export async function setCustomerActiveAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  await requirePagePermission({ customer: ['update'] })
  const { organizationId } = await requirePageOrg()
  const id = String(formData.get('customerId') ?? '')
  const active = String(formData.get('active') ?? '') === 'true'

  if (!(await getCustomer(id, organizationId))) return { error: 'Pelanggan tidak ditemukan.' }
  try {
    await db.execute(sql`
      update customers set active = ${active}, updated_at = now()
       where id = ${id} and organization_id = ${organizationId}`)
  } catch (e) {
    return { error: formError(e, 'Gagal memperbarui status pelanggan.') }
  }
  revalidatePath('/dashboard/customers')
  revalidatePath(`/dashboard/customers/${id}`)
  return { done: true }
}
