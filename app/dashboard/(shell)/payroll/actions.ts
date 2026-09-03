'use server'

import { revalidatePath } from 'next/cache'
import { requirePageOrg, requirePagePermission } from '@/lib/session'
import { addDeduction, removeDeduction, setBaseSalary } from '@/lib/payroll'
import { parseMoney } from '@/lib/money'
import { salonSettings } from '@/lib/service'
import { type FormState } from '@/lib/form-state'

const failed = (e: unknown, fallback: string) => {
  const code = e instanceof Error ? e.message : ''
  if (code === 'NOT_FOUND') return { error: 'Data tidak ditemukan.' }
  if (code === 'BAD_AMOUNT') return { error: 'Jumlah tidak valid.' }
  return { error: fallback }
}

export async function addDeductionAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  const session = await requirePagePermission({ payroll: ['read'] })
  const { organizationId } = await requirePageOrg()
  const { currency } = await salonSettings(organizationId)

  const amount = parseMoney(String(formData.get('amount') ?? ''), currency)
  if (amount === null || amount <= 0) return { error: 'Jumlah tidak valid.' }

  try {
    await addDeduction({
      organizationId,
      userId: String(formData.get('userId') ?? ''),
      month: String(formData.get('month') ?? ''),
      amount,
      note: String(formData.get('note') ?? '').trim() || null,
      actorUserId: session.user.id,
    })
  } catch (e) {
    return failed(e, 'Potongan gagal disimpan.')
  }
  revalidatePath('/dashboard/payroll')
  return { done: true }
}

export async function removeDeductionAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  await requirePagePermission({ payroll: ['read'] })
  const { organizationId } = await requirePageOrg()
  try {
    await removeDeduction(String(formData.get('id') ?? ''), organizationId)
  } catch (e) {
    return failed(e, 'Potongan gagal dihapus.')
  }
  revalidatePath('/dashboard/payroll')
  return { done: true }
}

/**
 * Edited on the staff page, not here: a base salary belongs with the role and
 * the branch, and payroll is where it is READ.
 *
 * Guarded by payroll:['read'] rather than staff:['update'] -- what someone is
 * paid is a payroll fact, and a role that may move a stylist between branches
 * need not be able to change their salary.
 */
export async function setBaseSalaryAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  await requirePagePermission({ payroll: ['read'] })
  const { organizationId } = await requirePageOrg()
  const { currency } = await salonSettings(organizationId)

  const raw = String(formData.get('baseSalary') ?? '').trim()
  // Empty means NOT SALARIED, which is a different statement from zero
  // (spec 2.1) -- so an empty field clears it rather than storing 0.
  const baseSalary = raw === '' ? null : parseMoney(raw, currency)
  if (raw !== '' && baseSalary === null) return { error: 'Gaji pokok tidak valid.' }

  try {
    await setBaseSalary(String(formData.get('userId') ?? ''), organizationId, baseSalary)
  } catch (e) {
    return failed(e, 'Gaji pokok gagal disimpan.')
  }
  revalidatePath('/dashboard/payroll')
  return { done: true }
}
