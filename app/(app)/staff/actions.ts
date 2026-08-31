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

const CLOSED_MSG = 'Cabang ini nonaktif. Aktifkan dulu sebelum menempatkan staf.'
const OVERCAP_MSG = 'Cabang ini terkunci oleh batas paket. Upgrade untuk menempatkan staf.'

/**
 * Used by transferStaffAction only -- createStaffAction goes through
 * provisionStaff, which now carries this same guard itself (lib/staff.ts),
 * so every creation path (this Server Action, the JSON API) gets it once
 * rather than once per caller.
 *
 * The order of these two `if`s is NOT load-bearing: getBranchStatus already
 * resolves 'closed' vs 'over_cap' exclusively before returning (it checks
 * `!active` first and only inspects `within_cap` while still active), and a
 * deactivated branch is excluded from branch_entitlement's ranking entirely,
 * so `within_cap` reads NULL, never `false`, once closed. Swapping these two
 * checks cannot change the result for any input -- verified by actually
 * swapping them and re-running staff:check (see task-5-report.md). Kept in
 * this order anyway because it reads the way the copy is decided: closed
 * first, because the remedy is reactivation, not an upgrade. The real
 * precedence guarantee lives in getBranchStatus, covered by
 * branch-check.mjs:109-111 ("a deactivated branch is closed, not over_cap").
 */
async function branchWriteError(teamId: string): Promise<string | null> {
  const status = await getBranchStatus(teamId)
  if (status === 'closed') return CLOSED_MSG
  if (status === 'over_cap') return OVERCAP_MSG
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

  try {
    await provisionStaff({ organizationId, name, email, password, role, teamId })
  } catch (e) {
    // A branch the owner closed, or one the plan tier has outgrown, must not
    // silently acquire a new hire -- provisionStaff itself throws these
    // (lib/staff.ts), so every creation path gets the guard once.
    if (e instanceof PlanError && e.code === 'BRANCH_LOCKED') {
      return { error: OVERCAP_MSG }
    }
    if (e instanceof Error && e.message === 'BRANCH_CLOSED') {
      return { error: CLOSED_MSG }
    }
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

  // Same allow-list createStaffAction uses, and for the same reason: without
  // it, a raw role=owner POST still gets refused (better-auth's own
  // updateMemberRole blocks the escalation, since the caller isn't the
  // creator), but its English APIError message would surface verbatim
  // through formError into this Indonesian-only screen.
  if (!ASSIGNABLE_ROLES.includes(role)) return { error: 'Peran tidak valid.' }
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
  // Owner and admin are salon-wide and must keep team_id null (spec §4) --
  // the same invariant createStaffAction's pairing check protects at
  // creation time. Without this, the page would let an admin park an owner
  // on a branch with no error anywhere.
  if (!target.role.split(',').some((r) => NEEDS_BRANCH.includes(r))) {
    return { error: 'Peran ini tidak ditempatkan di cabang.' }
  }
  if (!teamId) return { error: 'Pilih cabang.' }

  const branchError = await branchWriteError(teamId)
  if (branchError) return { error: branchError }

  // No separate ownership pre-check: assignBranch's own exists() guard is
  // authoritative here (it's the first standalone caller that actually
  // exercises it -- see lib/staff.ts). A foreign or bogus teamId updates 0
  // rows and reads as not-found, same as a bogus one, without a second
  // query duplicating what assignBranch already does.
  const updated = await assignBranch(userId, organizationId, teamId)
  if (!updated) return { error: 'Cabang tidak ditemukan.' }

  revalidateStaff(userId)
  return { done: true }
}
