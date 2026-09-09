'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { normalizePhone } from '@/lib/phone'
import {
  createCustomer, deactivateCustomer, getCustomer, reactivateCustomer, updateCustomer,
} from '@/lib/customer'
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
  const actor = await requirePagePermission({ customer: ['create'] })
  const { organizationId } = await requirePageOrg()
  const { name, phone, phoneKey, notes } = readForm(formData)

  if (!name) return { error: 'Nama pelanggan wajib diisi.' }
  // A phone that is present but has no digits at all is a typo, not an
  // intentional blank -- storing it would make the customer unfindable by
  // number while looking as though they had one.
  if (phone && !phoneKey) return { error: 'Nomor tidak valid.' }

  try {
    await createCustomer({ organizationId, name, phone, notes, actorUserId: actor.user.id })
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
  const actor = await requirePagePermission({ customer: ['update'] })
  const { organizationId } = await requirePageOrg()
  const id = String(formData.get('customerId') ?? '')
  const { name, phone, notes, phoneKey } = readForm(formData)

  if (!(await getCustomer(id, organizationId))) return { error: 'Pelanggan tidak ditemukan.' }
  if (!name) return { error: 'Nama pelanggan wajib diisi.' }
  if (phone && !phoneKey) return { error: 'Nomor tidak valid.' }

  try {
    await updateCustomer(id, organizationId, { name, phone, notes }, actor.user.id)
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
  const actor = await requirePagePermission({ customer: ['update'] })
  const { organizationId } = await requirePageOrg()
  const id = String(formData.get('customerId') ?? '')
  const active = String(formData.get('active') ?? '') === 'true'

  if (!(await getCustomer(id, organizationId))) return { error: 'Pelanggan tidak ditemukan.' }
  try {
    if (active) {
      await reactivateCustomer(id, organizationId, actor.user.id)
    } else {
      await deactivateCustomer(id, organizationId, actor.user.id)
    }
  } catch (e) {
    return { error: formError(e, 'Gagal memperbarui status pelanggan.') }
  }
  revalidatePath('/dashboard/customers')
  revalidatePath(`/dashboard/customers/${id}`)
  return { done: true }
}
