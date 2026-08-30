'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { sql } from 'drizzle-orm'
import { APIError } from 'better-auth/api'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { assignedStaff } from '@/lib/branch'
import { requirePagePermission, requirePageOrg } from '@/lib/session'
import { formError, type FormState } from '@/lib/form-state'

/**
 * The branch's current state, or null when the id is unknown OR belongs to
 * another salon — the caller cannot tell those apart, and neither should the
 * error message. Every mutation below runs this first: without it a mismatched
 * id updates 0 rows and still reports success.
 */
async function ownedBranch(teamId: string, organizationId: string) {
  const { rows } = await db.execute(sql`
    select p.active from branch_profiles p
      join teams t on t.id = p.team_id
     where t.id = ${teamId} and t.organization_id = ${organizationId}
     limit 1`)
  return (rows[0] as { active: boolean } | undefined) ?? null
}

const NOT_FOUND = { error: 'Cabang tidak ditemukan.' }

/** Both detail forms and the status form live on this page. */
function revalidateBranch(teamId: string) {
  revalidatePath('/branches')
  revalidatePath(`/branches/${teamId}`)
}

export async function createBranchAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  await requirePagePermission({ branch: ['create'] })
  const { organizationId, user } = await requirePageOrg()
  const name = String(formData.get('name') ?? '').trim()
  if (!name) return { error: 'Nama cabang wajib diisi.' }

  let teamId: string
  try {
    const team = await auth.api.createTeam({
      body: { name, organizationId },
      headers: await headers(),
    })
    teamId = team.id
  } catch (e) {
    // assertQuota (lib/auth.ts) wraps the 402 as `new APIError('PAYMENT_REQUIRED', ...)`.
    // better-call's InternalAPIError keeps the STRING key on `.status` and derives the
    // numeric code onto `.statusCode` — `e.status === 402` never matches.
    if (e instanceof APIError && e.statusCode === 402) {
      return { error: 'Batas cabang paket Anda sudah tercapai. Upgrade untuk menambah cabang.' }
    }
    return { error: formError(e, 'Gagal membuat cabang.') }
  }

  try {
    // Management membership is navigational: setActiveTeam refuses a user with
    // no team_members row, so without this the creator can edit the branch they
    // just made but never stand in it, and everything behind requireBranch() is
    // unreachable for it. addTeamMember is find-or-create and keeps
    // teams.member_count in step; ranking is by teams.created_at, so enrolment
    // cannot move a branch's lock position. It does NOT make the creator staff
    // — see assignedStaff() in lib/branch.ts.
    await auth.api.addTeamMember({
      body: { teamId, userId: user.id, organizationId },
      headers: await headers(),
    })
  } catch (e) {
    return { error: formError(e, 'Cabang dibuat, tetapi Anda belum terdaftar di dalamnya.') }
  }

  const address = String(formData.get('address') ?? '').trim()
  const phone = String(formData.get('phone') ?? '').trim()
  if (address || phone) {
    // Keyed off the id createTeam just returned, not a re-derived "latest team in
    // this org" query — two concurrent creates would otherwise race and one
    // branch's address/phone could land on the other.
    await db.execute(sql`
      update branch_profiles set address = ${address || null}, phone = ${phone || null},
             updated_at = now()
       where team_id = ${teamId}`)
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
  // Before auth.api.updateTeam, not after: an unknown id used to rename the
  // team first and only then fail the profile write, leaving the branch renamed
  // while the user was told it failed.
  if (!await ownedBranch(teamId, organizationId)) return NOT_FOUND

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
  revalidateBranch(teamId)
  return { done: true }
}

export async function updateBranchHoursAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  await requirePagePermission({ branch: ['update'] })
  const { organizationId } = await requirePageOrg()
  const teamId = String(formData.get('teamId') ?? '')
  if (!teamId) return NOT_FOUND
  if (!await ownedBranch(teamId, organizationId)) return NOT_FOUND

  // Validate every day before writing any of them — a rejected submission
  // must not leave days 0..N-1 persisted while N..6 keep their old values.
  const days: { weekday: number; closed: boolean; opensAt: string; closesAt: string }[] = []
  for (let weekday = 0; weekday <= 6; weekday++) {
    const closed = formData.get(`closed-${weekday}`) === 'on'
    const opensAt = String(formData.get(`opens-${weekday}`) ?? '09:00')
    const closesAt = String(formData.get(`closes-${weekday}`) ?? '21:00')
    if (!closed && closesAt <= opensAt) {
      return { error: `Jam tutup harus setelah jam buka (hari ke-${weekday}).` }
    }
    days.push({ weekday, closed, opensAt, closesAt })
  }

  for (const { weekday, closed, opensAt, closesAt } of days) {
    await db.execute(sql`
      update branch_hours
         set closed = ${closed}, opens_at = ${opensAt}::time, closes_at = ${closesAt}::time
       where team_id = ${teamId} and weekday = ${weekday}
         and exists (select 1 from teams
                      where id = ${teamId} and organization_id = ${organizationId})`)
  }
  revalidateBranch(teamId)
  return { done: true }
}

export async function deactivateBranchAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  await requirePagePermission({ branch: ['update'] })
  const { organizationId } = await requirePageOrg()
  const teamId = String(formData.get('teamId') ?? '')
  if (!teamId) return NOT_FOUND
  const branch = await ownedBranch(teamId, organizationId)
  if (!branch) return NOT_FOUND

  const staff = await assignedStaff(teamId, organizationId)
  if (staff.length > 0) {
    return { error: `Pindahkan staf berikut lebih dulu: ${staff.join(', ')}.` }
  }

  // "The last active branch cannot be deactivated" is PREVENTED, not handled
  // (spec §7), so the count and the write are one statement. The CTE locks the
  // salon's open branches first: a second deactivation of a DIFFERENT branch
  // blocks there, then re-reads under READ COMMITTED, sees this branch already
  // closed, counts 1 and refuses. Two admins clicking together can no longer
  // leave a salon with nothing open. `in (select ... from live)` also carries
  // the org scoping and the "still open" check, so a foreign id and a repeat
  // click both land on 0 rows.
  const { rows: closed } = await db.execute(sql`
    with live as materialized (
      select p.team_id from branch_profiles p
        join teams t on t.id = p.team_id
       where t.organization_id = ${organizationId} and p.active
       order by p.team_id
         for update of p
    )
    update branch_profiles set active = false, deactivated_at = now(), updated_at = now()
     where team_id = ${teamId}
       and team_id in (select team_id from live)
       and (select count(*) from live) > 1
    returning team_id`)

  if (closed.length === 0) {
    // Two ways to affect no rows, and they are not the same news: a branch
    // that was already closed (a double submit) is a no-op, anything else is
    // the last-open-branch refusal. The foreign-id case never reaches here.
    return branch.active
      ? { error: 'Ini satu-satunya cabang aktif. Aktifkan cabang lain lebih dulu.' }
      : { done: true }
  }
  revalidateBranch(teamId)
  return { done: true }
}

export async function reactivateBranchAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  await requirePagePermission({ branch: ['update'] })
  const { organizationId } = await requirePageOrg()
  const teamId = String(formData.get('teamId') ?? '')
  if (!teamId) return NOT_FOUND
  if (!await ownedBranch(teamId, organizationId)) return NOT_FOUND
  await db.execute(sql`
    update branch_profiles set active = true, deactivated_at = null, updated_at = now()
     where team_id = ${teamId}
       and exists (select 1 from teams
                    where id = ${teamId} and organization_id = ${organizationId})`)
  revalidateBranch(teamId)
  return { done: true }
}
