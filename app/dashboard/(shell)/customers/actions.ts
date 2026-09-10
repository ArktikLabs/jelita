'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { normalizePhone } from '@/lib/phone'
import {
  createCustomer, CUSTOMER_LIST, deactivateCustomer, getCustomer, listCustomers,
  reactivateCustomer, updateCustomer, type CustomerRow,
} from '@/lib/customer'
import { requirePageOrg, requirePagePermission } from '@/lib/session'
import { formError, type FormState } from '@/lib/form-state'
import { bulkDeactivate, bulkMessage, resolveSelection, selectionFromForm } from '@/lib/bulk'
import { listHref } from '@/lib/list-url'

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

/**
 * §7's bulk action for this resource -- SelectionBar's seam
 * (app/dashboard/(shell)/customers/page.tsx). `deactivateCustomer` carries
 * no guard of its own (unlike staff's last-owner CTE), so every resolved id
 * always succeeds; `bulkDeactivate` still owns the counting, so a future
 * guard on this resource would be reported honestly with no change here.
 */
export async function deactivateSelectedCustomersAction(formData: FormData) {
  const actor = await requirePagePermission({ customer: ['update'] })
  const { organizationId } = await requirePageOrg()
  const { ids, allMatching, params } = selectionFromForm(formData)

  const { ids: targets, capped } = await resolveSelection({
    spec: CUSTOMER_LIST, params, ids, allMatching,
    list: (q) => listCustomers(organizationId, q),
    idOf: (r: CustomerRow) => r.id,
  })
  const outcome = await bulkDeactivate(
    targets, (id) => deactivateCustomer(id, organizationId, actor.user.id).then(() => true),
  )

  revalidatePath('/dashboard/customers')
  redirect(`/dashboard/customers${listHref(params, { bulkMsg: bulkMessage(outcome, '', capped) })}`)
}
