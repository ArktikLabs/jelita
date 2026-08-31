'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { PlanError } from '@/lib/plan/entitlements'
import { requirePageOrg, requirePagePermission } from '@/lib/session'
import { provisionStaff } from '@/lib/staff'
import { formError, type FormState } from '@/lib/form-state'
import type { SalonRole } from '@/lib/permissions'

const NEEDS_BRANCH = ['stylist', 'frontdesk']

export async function createStaffAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  await requirePagePermission({ staff: ['create'] })
  const { organizationId } = await requirePageOrg()

  const name = String(formData.get('name') ?? '').trim()
  const email = String(formData.get('email') ?? '').trim()
  const password = String(formData.get('password') ?? '')
  const role = String(formData.get('role') ?? '') as SalonRole
  const teamId = String(formData.get('teamId') ?? '').trim() || null

  if (!name || !email || !password) return { error: 'Nama, email dan kata sandi wajib diisi.' }
  if (password.length < 8) return { error: 'Kata sandi minimal 8 karakter.' }
  // Role decides assignment (spec §4): front desk has branch:read and no
  // switch, so an unassigned one would have nowhere to be; owners and admins
  // are salon-wide.
  if (NEEDS_BRANCH.includes(role) && !teamId) return { error: 'Pilih cabang untuk peran ini.' }
  if (!NEEDS_BRANCH.includes(role) && teamId) return { error: 'Peran ini tidak ditempatkan di cabang.' }

  try {
    await provisionStaff({ organizationId, name, email, password, role, teamId })
  } catch (e) {
    if (e instanceof PlanError) {
      return { error: 'Kuota staf paket Anda sudah tercapai. Upgrade untuk menambah staf.' }
    }
    if (e instanceof Error && e.message === 'EMAIL_TAKEN') {
      return { error: 'Email ini sudah terdaftar.' }
    }
    return { error: formError(e, 'Gagal menambah staf.') }
  }
  revalidatePath('/staff')
  redirect('/staff')
}
