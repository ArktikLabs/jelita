'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { sql } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { PlanError } from '@/lib/plan/entitlements'
import { getBranchStatus } from '@/lib/plan/branch'
import { requirePageOrg, requirePagePermission } from '@/lib/session'
import { provisionStaff, assignBranch, getStaff } from '@/lib/staff'
import { listBranches } from '@/lib/branch'
import { formError, type FormState } from '@/lib/form-state'
import type { SalonRole } from '@/lib/permissions'

const NEEDS_BRANCH = ['stylist', 'frontdesk']

// Allow-list, not "not owner": stays correct when a role is added later, and
// dynamicAccessControl means a custom role must be refused here too, not
// just the built-in 'owner'. staff:['create'] is held by admin as well as
// owner -- without this an admin could mint an owner and inherit rights
// (deleting the organization) they never held themselves.
const ASSIGNABLE_ROLES: SalonRole[] = ['admin', 'stylist', 'frontdesk']

const NOT_FOUND = { error: 'Staf tidak ditemukan.' }

/**
 * Shared by createStaffAction and transferStaffAction: a branch the salon
 * has shut or outgrown must not silently acquire staff. `closed` is checked
 * before `over_cap` -- matching getBranchStatus's own precedence -- because
 * the remedy for a closed branch is reactivation, not an upgrade.
 */
async function branchWriteError(teamId: string): Promise<string | null> {
  const status = await getBranchStatus(teamId)
  if (status === 'closed') return 'Cabang ini nonaktif. Aktifkan dulu sebelum menempatkan staf.'
  if (status === 'over_cap') return 'Cabang ini terkunci oleh batas paket. Upgrade untuk menempatkan staf.'
  return null
}

/** Does the actor's own `members.role` for this org contain 'owner'? */
async function isOwner(userId: string, organizationId: string) {
  const { rows } = await db.execute(sql`
    select role from members where user_id = ${userId} and organization_id = ${organizationId}
     limit 1`)
  return ((rows[0] as { role: string } | undefined)?.role ?? '').split(',').includes('owner')
}

/**
 * auth.api.updateMemberRole's `memberId` body field is the `members.id` row,
 * NOT the user id -- confirmed by reading
 * node_modules/better-auth/dist/plugins/organization/routes/crud-members.mjs:
 * it resolves the target via `adapter.findMemberById(ctx.body.memberId)`
 * whenever that id differs from the caller's own member id.
 */
async function memberIdFor(userId: string, organizationId: string) {
  const { rows } = await db.execute(sql`
    select id from members where user_id = ${userId} and organization_id = ${organizationId}
     limit 1`)
  return (rows[0] as { id: string } | undefined)?.id ?? null
}

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
  // This screen mints new logins -- it must never be the path to a second
  // owner or an unrecognised (custom) role. Promoting an existing member is
  // a different operation (better-auth's updateMemberRole), not this form.
  if (!ASSIGNABLE_ROLES.includes(role)) return { error: 'Peran tidak valid.' }
  // Role decides assignment (spec §4): front desk has branch:read and no
  // switch, so an unassigned one would have nowhere to be; owners and admins
  // are salon-wide.
  if (NEEDS_BRANCH.includes(role) && !teamId) return { error: 'Pilih cabang untuk peran ini.' }
  if (!NEEDS_BRANCH.includes(role) && teamId) return { error: 'Peran ini tidak ditempatkan di cabang.' }
  // A teamId from the client is untrusted -- checked against this org's own
  // branches before it ever reaches provisionStaff/addMember, so a foreign
  // or bogus id gets our own Indonesian copy instead of addMember's English
  // "Team not found" surfacing verbatim through formError.
  if (teamId && !(await listBranches(organizationId)).some((b) => b.teamId === teamId)) {
    return { error: 'Cabang tidak ditemukan.' }
  }
  // A branch the owner closed, or one the plan tier has outgrown, must not
  // silently acquire a new hire -- same guard the transfer action below uses.
  if (teamId) {
    const branchError = await branchWriteError(teamId)
    if (branchError) return { error: branchError }
  }

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

/** Both detail forms on /staff/[id] live on this page. */
function revalidateStaff(userId: string) {
  revalidatePath('/staff')
  revalidatePath(`/staff/${userId}`)
}

export async function updateStaffRoleAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  const actor = await requirePagePermission({ staff: ['update'] })
  const { organizationId } = await requirePageOrg()
  const userId = String(formData.get('userId') ?? '')
  const role = String(formData.get('role') ?? '') as SalonRole
  const teamId = String(formData.get('teamId') ?? '').trim() || null

  const target = await getStaff(userId, organizationId)
  if (!target) return NOT_FOUND
  // An admin must not be able to demote or remove an owner (spec §6.1).
  if (target.role.split(',').includes('owner') && !(await isOwner(actor.user.id, organizationId))) {
    return { error: 'Hanya pemilik yang dapat mengubah peran pemilik.' }
  }

  if (NEEDS_BRANCH.includes(role) && !teamId) return { error: 'Pilih cabang untuk peran ini.' }

  const memberId = await memberIdFor(userId, organizationId)
  if (!memberId) return NOT_FOUND

  try {
    await auth.api.updateMemberRole({
      body: { memberId, organizationId, role },
      headers: await headers(),
    })
  } catch (e) {
    return { error: formError(e, 'Gagal mengubah peran.') }
  }
  // Assignment follows role (spec §4): promoting to management clears the
  // branch, demoting requires one.
  await assignBranch(userId, organizationId, NEEDS_BRANCH.includes(role) ? teamId : null)

  revalidateStaff(userId)
  return { done: true }
}

export async function transferStaffAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  await requirePagePermission({ staff: ['update'] })
  const { organizationId } = await requirePageOrg()
  const userId = String(formData.get('userId') ?? '')
  const teamId = String(formData.get('teamId') ?? '').trim()

  const target = await getStaff(userId, organizationId)
  if (!target) return NOT_FOUND
  if (!teamId) return { error: 'Pilih cabang.' }
  // teamId is untrusted client input. getBranchStatus below has no
  // organization scoping of its own (it only knows a bare team id), so a
  // foreign teamId would read that OTHER salon's real status instead of
  // failing closed -- leaking that the branch exists (and its status) even
  // when the write itself is safely a no-op. Confirming ownership here
  // first, before ever calling getBranchStatus or assignBranch, makes a
  // foreign id read as not-found, the same as a bogus one.
  if (!(await listBranches(organizationId)).some((b) => b.teamId === teamId)) {
    return { error: 'Cabang tidak ditemukan.' }
  }

  const branchError = await branchWriteError(teamId)
  if (branchError) return { error: branchError }

  await assignBranch(userId, organizationId, teamId)

  revalidateStaff(userId)
  return { done: true }
}
