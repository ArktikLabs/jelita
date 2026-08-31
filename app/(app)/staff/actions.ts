'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { createLocalAccountIssuer } from 'better-auth'
import { sql } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { PlanError, requireQuota } from '@/lib/plan/entitlements'
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

/**
 * Deactivation is a departure, not a flag: it frees the plan seat
 * (countResource counts only active profiles) and cuts the session off.
 */
export async function deactivateStaffAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  // staff:['deactivate'], not ['update'] -- the statement already names this
  // operation separately (lib/permissions.ts). Owner and admin hold both, so
  // this changes nothing today; it means a role granted 'update' alone later
  // does not silently inherit the power to end someone's employment.
  const actor = await requirePagePermission({ staff: ['deactivate'] })
  const { organizationId } = await requirePageOrg()
  const userId = String(formData.get('userId') ?? '')
  if (!userId) return NOT_FOUND
  // Before the SQL, and before the not-found read: a one-owner salon whose
  // owner deactivates themselves is locked out of its own tenant with no
  // recovery short of a database edit. The last-owner rule below would catch
  // that one case, but not an owner among several -- who would still be
  // signing themselves out with a button labelled as an HR action.
  if (userId === actor.user.id) {
    return { error: 'Anda tidak dapat menonaktifkan akun Anda sendiri.' }
  }
  if (!(await getStaff(userId, organizationId))) return NOT_FOUND

  // "The last owner cannot be deactivated" is PREVENTED, not handled, so the
  // count and the write are ONE statement. Folding the count into the WHERE
  // alone is not enough: under READ COMMITTED two admins deactivating two
  // DIFFERENT owners would each read "2 owners" and both write, leaving the
  // salon ownerless. The materialized CTE locks every active owner row of the
  // salon first (ordered, so two of these cannot deadlock), so the second
  // transaction blocks there, re-reads the now-inactive row under EvalPlanQual,
  // counts 1 and refuses. Same shape as deactivateBranchAction.
  const { rows: closed } = await db.execute(sql`
    with owners as materialized (
      select s.user_id from staff_profiles s
        join members m on m.user_id = s.user_id
                      and m.organization_id = s.organization_id
       where s.organization_id = ${organizationId} and s.active
         and (string_to_array(m.role, ',') && array['owner'])
       order by s.user_id
         for update of s
    )
    update staff_profiles
       set active = false, deactivated_at = now(), updated_at = now()
     where user_id = ${userId} and organization_id = ${organizationId}
       and active
       and (user_id not in (select user_id from owners)
            or (select count(*) from owners) > 1)
    returning user_id`)

  if (closed.length === 0) {
    // Two remaining ways to affect no rows, and they are not the same news:
    // already inactive (a double submit) is a no-op, anything else is the
    // last-owner refusal. Re-read rather than trust the pre-read above -- the
    // pre-read is stale in exactly the racing case, which is how the branch
    // screen once told an owner they had one branch when they had three.
    const target = await getStaff(userId, organizationId)
    if (!target) return NOT_FOUND
    return target.active
      ? { error: 'Ini pemilik terakhir yang aktif. Tunjuk pemilik lain lebih dulu.' }
      : { done: true }
  }

  // Without this a dismissed employee keeps working until their cookie
  // expires. deleteUserSessions drops every session row for the user
  // (node_modules/better-auth/dist/db/internal-adapter.mjs:504);
  // revokeUserSessions belongs to the admin plugin, which this project does
  // not use because its roles are global.
  const ctx = await auth.$context
  await ctx.internalAdapter.deleteUserSessions(userId)

  revalidateStaff(userId)
  return { done: true }
}

/** Rehiring into a full plan is a 402, exactly like hiring. */
export async function reactivateStaffAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  await requirePagePermission({ staff: ['deactivate'] })
  const { organizationId } = await requirePageOrg()
  const userId = String(formData.get('userId') ?? '')
  const target = await getStaff(userId, organizationId)
  if (!target) return NOT_FOUND
  if (target.active) return { done: true }

  try {
    // Before the write, not after: an inactive profile is not counted, so the
    // seat is genuinely re-consumed here.
    await requireQuota('staff', organizationId)
  } catch (e) {
    if (e instanceof PlanError) {
      return { error: 'Kuota staf paket Anda sudah tercapai. Upgrade untuk mengaktifkan kembali.' }
    }
    return { error: formError(e, 'Gagal mengaktifkan staf.') }
  }

  await db.execute(sql`
    update staff_profiles
       set active = true, deactivated_at = null, updated_at = now()
     where user_id = ${userId} and organization_id = ${organizationId}`)
  revalidateStaff(userId)
  return { done: true }
}

/**
 * A forgotten password, reset at the front desk -- PRD §3 staff have no
 * working email, so better-auth's token round-trip is unavailable to them.
 */
export async function resetStaffPasswordAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  const actor = await requirePagePermission({ staff: ['update'] })
  const { organizationId } = await requirePageOrg()
  const userId = String(formData.get('userId') ?? '')
  const password = String(formData.get('password') ?? '')
  const target = await getStaff(userId, organizationId)
  if (!target) return NOT_FOUND
  if (password.length < 8) return { error: 'Kata sandi minimal 8 karakter.' }
  // Same rule as updateStaffRoleAction (spec §6.1), and for a sharper reason:
  // handing an admin the owner's password is handing them the owner's account,
  // including rights (deleting the organization) an admin never held.
  if (target.role.split(',').includes('owner') && !(await isOwner(actor.user.id, organizationId))) {
    return { error: 'Hanya pemilik yang dapat mengatur ulang kata sandi pemilik.' }
  }

  const ctx = await auth.$context
  const hash = await ctx.password.hash(password)
  // Mirrors better-auth's own reset-password route
  // (node_modules/better-auth/dist/api/routes/password.mjs:163-171):
  // updatePassword matches on userId + providerId + issuer + accountId, so a
  // member who never had a credential account would take a silent no-op --
  // it creates one instead, exactly as that route does.
  if (await ctx.internalAdapter.findCredentialAccount(userId)) {
    await ctx.internalAdapter.updatePassword(userId, hash)
  } else {
    await ctx.internalAdapter.createAccount({
      userId,
      providerId: 'credential',
      issuer: createLocalAccountIssuer('credential'),
      accountId: userId,
      password: hash,
    })
  }
  // A reset that leaves the old sessions alive does not lock out whoever
  // prompted the reset.
  await ctx.internalAdapter.deleteUserSessions(userId)

  revalidateStaff(userId)
  return { done: true }
}
