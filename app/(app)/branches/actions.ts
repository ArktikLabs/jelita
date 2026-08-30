'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { sql } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { requirePagePermission, requirePageOrg } from '@/lib/session'
import { PlanError } from '@/lib/plan/entitlements'
import { formError, type FormState } from '@/lib/form-state'

export async function createBranchAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  await requirePagePermission({ branch: ['create'] })
  const { organizationId } = await requirePageOrg()
  const name = String(formData.get('name') ?? '').trim()
  if (!name) return { error: 'Nama cabang wajib diisi.' }

  try {
    await auth.api.createTeam({
      body: { name, organizationId },
      headers: await headers(),
    })
  } catch (e) {
    // beforeCreateTeam raises 402 when the tier has no room.
    if (e instanceof PlanError || (e as { status?: number })?.status === 402) {
      return { error: 'Batas cabang paket Anda sudah tercapai. Upgrade untuk menambah cabang.' }
    }
    return { error: formError(e, 'Gagal membuat cabang.') }
  }

  const address = String(formData.get('address') ?? '').trim()
  const phone = String(formData.get('phone') ?? '').trim()
  if (address || phone) {
    await db.execute(sql`
      update branch_profiles set address = ${address || null}, phone = ${phone || null},
             updated_at = now()
       where team_id = (select id from teams where organization_id = ${organizationId}
                         order by created_at desc, id desc limit 1)`)
  }
  revalidatePath('/branches')
  return { done: true }
}

export async function updateBranchDetailsAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  await requirePagePermission({ branch: ['update'] })
  const { organizationId } = await requirePageOrg()
  const teamId = String(formData.get('teamId') ?? '')
  const name = String(formData.get('name') ?? '').trim()
  if (!teamId || !name) return { error: 'Nama cabang wajib diisi.' }

  try {
    await auth.api.updateTeam({
      body: { teamId, data: { name } },
      headers: await headers(),
    })
    await db.execute(sql`
      update branch_profiles
         set address = ${String(formData.get('address') ?? '').trim() || null},
             phone = ${String(formData.get('phone') ?? '').trim() || null},
             updated_at = now()
       where team_id = ${teamId}
         and exists (select 1 from teams
                      where id = ${teamId} and organization_id = ${organizationId})`)
  } catch (e) {
    return { error: formError(e, 'Gagal menyimpan cabang.') }
  }
  revalidatePath('/branches')
  return { done: true }
}

export async function updateBranchHoursAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  await requirePagePermission({ branch: ['update'] })
  const { organizationId } = await requirePageOrg()
  const teamId = String(formData.get('teamId') ?? '')
  if (!teamId) return { error: 'Cabang tidak ditemukan.' }

  for (let weekday = 0; weekday <= 6; weekday++) {
    const closed = formData.get(`closed-${weekday}`) === 'on'
    const opensAt = String(formData.get(`opens-${weekday}`) ?? '09:00')
    const closesAt = String(formData.get(`closes-${weekday}`) ?? '21:00')
    if (!closed && closesAt <= opensAt) {
      return { error: `Jam tutup harus setelah jam buka (hari ke-${weekday}).` }
    }
    await db.execute(sql`
      update branch_hours
         set closed = ${closed}, opens_at = ${opensAt}::time, closes_at = ${closesAt}::time
       where team_id = ${teamId} and weekday = ${weekday}
         and exists (select 1 from teams
                      where id = ${teamId} and organization_id = ${organizationId})`)
  }
  revalidatePath(`/branches/${teamId}`)
  return { done: true }
}

export async function deactivateBranchAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  await requirePagePermission({ branch: ['update'] })
  const { organizationId } = await requirePageOrg()
  const teamId = String(formData.get('teamId') ?? '')
  if (!teamId) return { error: 'Cabang tidak ditemukan.' }

  const { rows: staff } = await db.execute(sql`
    select u.name from team_members tm
      join users u on u.id = tm.user_id
     where tm.team_id = ${teamId} order by u.name`)
  if (staff.length > 0) {
    const names = (staff as { name: string }[]).map((s) => s.name).join(', ')
    return { error: `Pindahkan staf berikut lebih dulu: ${names}.` }
  }

  const { rows: live } = await db.execute(sql`
    select count(*)::int as n from teams t
      join branch_profiles p on p.team_id = t.id
     where t.organization_id = ${organizationId} and p.active`)
  if (Number((live[0] as { n: number }).n) <= 1) {
    return { error: 'Ini satu-satunya cabang aktif. Aktifkan cabang lain lebih dulu.' }
  }

  await db.execute(sql`
    update branch_profiles set active = false, deactivated_at = now(), updated_at = now()
     where team_id = ${teamId}
       and exists (select 1 from teams
                    where id = ${teamId} and organization_id = ${organizationId})`)
  revalidatePath('/branches')
  return { done: true }
}

export async function reactivateBranchAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  await requirePagePermission({ branch: ['update'] })
  const { organizationId } = await requirePageOrg()
  const teamId = String(formData.get('teamId') ?? '')
  if (!teamId) return { error: 'Cabang tidak ditemukan.' }
  await db.execute(sql`
    update branch_profiles set active = true, deactivated_at = null, updated_at = now()
     where team_id = ${teamId}
       and exists (select 1 from teams
                    where id = ${teamId} and organization_id = ${organizationId})`)
  revalidatePath('/branches')
  return { done: true }
}
