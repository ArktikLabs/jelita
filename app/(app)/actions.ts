'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { sql } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { requirePagePermission, requirePageOrg } from '@/lib/session'
import { formError, type FormState } from '@/lib/form-state'

export async function signOutAction() {
  await auth.api.signOut({ headers: await headers() })
  redirect('/login')
}

export async function switchBranchAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  // Conditional rendering is presentation. This is a public POST endpoint and
  // guards itself — the same lesson as the session-revoke fix.
  await requirePagePermission({ branch: ['switch'] })
  const { organizationId, user } = await requirePageOrg()
  const teamId = String(formData.get('teamId') ?? '')
  if (!teamId) return { error: 'Cabang tidak ditemukan.' }

  // Verified: better-auth's /organization/set-active-team DOES scope the
  // team lookup by session.session.activeOrganizationId internally (see
  // adapter.findTeamById in crud-team.mjs). This check stays anyway — belt
  // and braces, from the session rather than trusting the library — the
  // same lesson as the cross-tenant defect already found in this plan.
  const { rows } = await db.execute(sql`
    select 1 from teams where id = ${teamId} and organization_id = ${organizationId} limit 1`)
  if (rows.length === 0) return { error: 'Cabang tidak ditemukan.' }

  try {
    // The switcher lists every branch of the salon, but setActiveTeam demands a
    // team_members row — so an owner picking a branch an admin created got
    // better-auth's untranslated English error and a silently reverting
    // dropdown. Enrol them instead of hiding the branch: management is entitled
    // to enter any branch of its own salon, and this runs only AFTER the
    // permission and org checks above. addTeamMember is find-or-create, and the
    // row is navigational only — it never makes them staff (see assignedStaff
    // in lib/branch.ts) and never affects lock ranking.
    await auth.api.addTeamMember({
      body: { teamId, userId: user.id, organizationId },
      headers: await headers(),
    })
    await auth.api.setActiveTeam({ body: { teamId }, headers: await headers() })
  } catch (e) {
    return { error: formError(e, 'Gagal berpindah cabang.') }
  }
  revalidatePath('/', 'layout')
  return { done: true }
}
