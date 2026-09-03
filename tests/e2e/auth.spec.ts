import { expect, test } from '@playwright/test'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from '../db'
import { client, createLogin, BASE_URL } from './fixtures'
import { clearMail, waitForMail } from './mail'

/**
 * Sign-up, sign-in, sessions, role/permission enforcement, password change,
 * forgot-password, invitations, dynamic access control, session management
 * and /api/staff provisioning -- driven over HTTP against the running app.
 *
 * "Sign-up returns 200" and "the reset round trip works" are already proven
 * in tests/e2e/ui.spec.ts ('register, verify, auto sign-in...' and 'password
 * reset round trip'); this file re-asserts the parts of those two flows it
 * needs as a stepping stone, but its OWN claims are the ones ui.spec.ts does
 * not make: no session before verification, anti-enumeration on duplicate
 * sign-up, the weak-password rejection, and that a reset token cannot be
 * replayed.
 *
 * lib/auth.ts rate-limits /sign-up/email to 5/hour and /request-password-reset
 * to 5/hour, process-wide, shared with every other e2e spec file (see
 * tests/e2e/fixtures.ts). This file's own subject -- sign-up validation and
 * anti-enumeration -- needs 3 real calls to /sign-up/email, so every other
 * account here (front desk, stylist) is bootstrapped with createLogin instead,
 * which spends none of that budget.
 */
const DOMAIN = 'authcheck.local'
const PW = 'demo12345'

const pool = new Pool({ connectionString: TEST_DATABASE_URL })

const can = async (
  ctx: Awaited<ReturnType<typeof client>>, permissions: Record<string, string[]>,
) => (await (await ctx.post('/api/auth/organization/has-permission',
  { data: { permissions } })).json())?.success === true

test.beforeAll(async () => {
  await pool.query(`delete from organizations where slug = 'authcheck'`)
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`])
  clearMail()
})

test.afterAll(() => pool.end())

test.describe.serial('sign-up, sessions, roles, permissions and staff provisioning', () => {
  let owner: Awaited<ReturnType<typeof client>>
  let owner2: Awaited<ReturnType<typeof client>>
  let desk: Awaited<ReturnType<typeof client>>
  let sty: Awaited<ReturnType<typeof client>>
  let orgId: string
  let kemang: string
  let bsd: string
  let deskMemberId: string
  let styMemberId: string
  let styUserId: string

  test.beforeAll(async () => {
    owner = await client()
    desk = await client()
    sty = await client()
  })
  test.afterAll(async () => {
    await owner.dispose()
    await desk.dispose()
    await sty.dispose()
  })

  // ---------------------------------------------------------------- sign-up
  test('sign-up succeeds but establishes no session until the email is verified', async () => {
    const res = await owner.post('/api/auth/sign-up/email',
      { data: { name: 'Aan Owner', email: `owner@${DOMAIN}`, password: PW } })
    expect(res.status(), await res.text()).toBe(200)

    const sess = await owner.get('/api/auth/get-session')
    expect((await sess.json())?.user).toBeFalsy()
  })

  test('a password under the minimum length is rejected', async () => {
    const weak = await (await client()).post('/api/auth/sign-up/email',
      { data: { name: 'X', email: `weak@${DOMAIN}`, password: 'short' } })
    expect(weak.status()).toBeGreaterThanOrEqual(400)
  })

  test('duplicate registration returns a generic success (anti-enumeration)', async () => {
    const dup = await (await client()).post('/api/auth/sign-up/email',
      { data: { name: 'X', email: `owner@${DOMAIN}`, password: PW } })
    const body = await dup.json()
    expect(dup.status(), JSON.stringify(body)).toBe(200)
    expect(body.user).toBeTruthy()
    expect(body.token).toBeNull()
  })

  test('sign in, and a wrong password is rejected', async () => {
    // requireEmailVerification is on; marking verified directly is the
    // correct fix here, not loosening the setting to keep the suite green.
    await pool.query(`update users set email_verified = true where email = $1`, [`owner@${DOMAIN}`])
    const signin = await owner.post('/api/auth/sign-in/email',
      { data: { email: `owner@${DOMAIN}`, password: PW } })
    expect(signin.status(), await signin.text()).toBe(200)

    const badPw = await (await client()).post('/api/auth/sign-in/email',
      { data: { email: `owner@${DOMAIN}`, password: 'wrongpassword' } })
    expect(badPw.status()).toBeGreaterThanOrEqual(400)
  })

  // ------------------------------------------------------------- tenancy
  test('organization created, and its creator gets the owner role', async () => {
    const org = await owner.post('/api/auth/organization/create',
      { data: { name: 'Jelita Authcheck', slug: 'authcheck' } })
    expect(org.status(), await org.text()).toBe(200)
    orgId = (await org.json()).id
    await owner.post('/api/auth/organization/set-active', { data: { organizationId: orgId } })

    // This suite adds four members and multiple teams -- over free tier's
    // staff (3) and branch (1) caps once requireQuota is enforced. business
    // has no plan_limits rows at all, so both are unlimited. The fix belongs
    // in this suite's own fixture setup, not in loosening the quota guard.
    await pool.query(`
      update subscriptions set plan_id = (select id from plans where key = 'business')
       where organization_id = $1`, [orgId])

    const role = await owner.get('/api/auth/organization/get-active-member-role')
    expect(JSON.stringify(await role.json())).toContain('owner')
  })

  test('two branches created as teams', async () => {
    const mk = async (name: string) => (await (await owner.post('/api/auth/organization/create-team',
      { data: { name, organizationId: orgId } })).json()).id
    kemang = await mk('Kemang')
    bsd = await mk('BSD')
    expect(kemang).toBeTruthy()
    expect(bsd).toBeTruthy()
  })

  // --------------------------------------------------- invite + assign role
  test('front desk is invited with a role and branch, and accepts', async () => {
    await createLogin(pool, { name: 'Rani Kasir', email: `kasir@${DOMAIN}`, password: PW })
    const signin = await desk.post('/api/auth/sign-in/email',
      { data: { email: `kasir@${DOMAIN}`, password: PW } })
    expect(signin.status(), await signin.text()).toBe(200)

    const invite = await owner.post('/api/auth/organization/invite-member',
      { data: { email: `kasir@${DOMAIN}`, role: 'frontdesk', organizationId: orgId, teamId: kemang } })
    expect(invite.status(), await invite.text()).toBe(200)
    const invitationId = (await invite.json()).id

    const accept = await desk.post('/api/auth/organization/accept-invitation', { data: { invitationId } })
    expect(accept.status(), await accept.text()).toBe(200)
  })

  test('stylist is invited and accepts too', async () => {
    await createLogin(pool, { name: 'Sinta Stylist', email: `sinta@${DOMAIN}`, password: PW })
    const signin = await sty.post('/api/auth/sign-in/email',
      { data: { email: `sinta@${DOMAIN}`, password: PW } })
    expect(signin.status(), await signin.text()).toBe(200)

    const invite = await owner.post('/api/auth/organization/invite-member',
      { data: { email: `sinta@${DOMAIN}`, role: 'stylist', organizationId: orgId, teamId: kemang } })
    expect(invite.status(), await invite.text()).toBe(200)

    const accept = await sty.post('/api/auth/organization/accept-invitation',
      { data: { invitationId: (await invite.json()).id } })
    expect(accept.status(), await accept.text()).toBe(200)
  })

  test('the invitation email was dispatched', async () => {
    expect(await waitForMail(/(Undangan bergabung)/)).toBeTruthy()
  })

  test('roles persist on the member list, and a second branch can be assigned', async () => {
    const members = await owner.get(`/api/auth/organization/list-members?organizationId=${orgId}`)
    const list = (await members.json())?.members ?? []
    const byRole = Object.fromEntries(list.map((m: { user: { email: string }, role: string }) =>
      [m.user?.email, m.role]))
    expect(byRole[`kasir@${DOMAIN}`]).toBe('frontdesk')
    expect(byRole[`sinta@${DOMAIN}`]).toBe('stylist')

    deskMemberId = list.find((m: { user: { email: string } }) => m.user?.email === `kasir@${DOMAIN}`)?.id
    const styMember = list.find((m: { user: { email: string } }) => m.user?.email === `sinta@${DOMAIN}`)
    styMemberId = styMember?.id
    styUserId = styMember?.userId

    const addT = await owner.post('/api/auth/organization/add-team-member',
      { data: { teamId: bsd, userId: styUserId } })
    expect(addT.status(), await addT.text()).toBe(200)
  })

  test('front desk is scoped to exactly one branch (§5.8)', async () => {
    const teams = await desk.get('/api/auth/organization/list-user-teams')
    const ids = ((await teams.json()) ?? []).map((t: { id: string }) => t.id)
    expect(ids).toEqual([kemang])
  })

  // ------------------------------------------------------------ permissions
  test('owner can void a transaction and run payroll', async () => {
    expect(await can(owner, { pos: ['void'] })).toBe(true)
    expect(await can(owner, { payroll: ['run'] })).toBe(true)
  })

  test('front desk can checkout, but not void, read payroll, or manage staff', async () => {
    expect(await can(desk, { pos: ['checkout'] })).toBe(true)
    expect(await can(desk, { pos: ['void'] }), '§5.2 immutability').toBe(false)
    expect(await can(desk, { payroll: ['read'] })).toBe(false)
    expect(await can(desk, { staff: ['create'] })).toBe(false)
  })

  test('stylist can read bookings and their own commission, but not checkout or all commissions', async () => {
    expect(await can(sty, { booking: ['read'] })).toBe(true)
    expect(await can(sty, { pos: ['checkout'] })).toBe(false)
    expect(await can(sty, { commission: ['read'] })).toBe(false)
    expect(await can(sty, { commission: ['read:own'] })).toBe(true)
  })

  test('front desk cannot escalate a role', async () => {
    const escalate = await desk.post('/api/auth/organization/update-member-role',
      { data: { organizationId: orgId, memberId: styMemberId, role: 'owner' } })
    expect(escalate.status()).toBeGreaterThanOrEqual(400)
  })

  // --------------------------------------------------------- role reassign
  test('role reassignment takes effect immediately, and reverts', async () => {
    const promote = await owner.post('/api/auth/organization/update-member-role',
      { data: { organizationId: orgId, memberId: deskMemberId, role: 'admin' } })
    expect(promote.status(), await promote.text()).toBe(200)
    expect(await can(desk, { pos: ['void'] })).toBe(true)

    const demote = await owner.post('/api/auth/organization/update-member-role',
      { data: { organizationId: orgId, memberId: deskMemberId, role: 'frontdesk' } })
    expect(demote.status(), await demote.text()).toBe(200)
    expect(await can(desk, { pos: ['void'] })).toBe(false)
  })

  // ------------------------------------------------------- change password
  test('change-password rejects the wrong current password and accepts the right one', async () => {
    const bad = await desk.post('/api/auth/change-password',
      { data: { currentPassword: 'wrongpassword', newPassword: 'newpass12345' } })
    expect(bad.status()).toBeGreaterThanOrEqual(400)

    const good = await desk.post('/api/auth/change-password',
      { data: { currentPassword: PW, newPassword: 'newpass12345', revokeOtherSessions: true } })
    expect(good.status(), await good.text()).toBe(200)
  })

  test('the old password stops working and the new one signs in', async () => {
    const oldLogin = await (await client()).post('/api/auth/sign-in/email',
      { data: { email: `kasir@${DOMAIN}`, password: PW } })
    expect(oldLogin.status()).toBeGreaterThanOrEqual(400)

    const newLogin = await (await client()).post('/api/auth/sign-in/email',
      { data: { email: `kasir@${DOMAIN}`, password: 'newpass12345' } })
    expect(newLogin.status()).toBe(200)
  })

  // ------------------------------------------------------- forgot password
  // Covers what ui.spec.ts's own round trip doesn't: the request itself
  // returns 200, and a spent token cannot be replayed.
  test('forgot/reset password: round trip, and the token cannot be reused', async () => {
    clearMail()
    const fp = await (await client()).post('/api/auth/request-password-reset',
      { data: { email: `sinta@${DOMAIN}`, redirectTo: `${BASE_URL}/reset-password` } })
    expect(fp.status(), await fp.text()).toBe(200)

    const token = await waitForMail(/token=([A-Za-z0-9._-]+)/)
    expect(token).toBeTruthy()

    const reset = await (await client()).post('/api/auth/reset-password',
      { data: { newPassword: 'resetpass12345', token } })
    expect(reset.status(), await reset.text()).toBe(200)

    const reuse = await (await client()).post('/api/auth/reset-password',
      { data: { newPassword: 'anotherpass123', token } })
    expect(reuse.status()).toBeGreaterThanOrEqual(400)
    // The next test signs in with the reset password -- that IS "sign-in with
    // reset password works" (no need to spend a second sign-in call proving
    // it twice; see the rate-limit note at the top of this file).
  })

  // ------------------------------------------- dynamic AC ("assign permission")
  test('sign-in with the reset password works, and the stylist still cannot void', async () => {
    sty = await client()
    const signin = await sty.post('/api/auth/sign-in/email',
      { data: { email: `sinta@${DOMAIN}`, password: 'resetpass12345' } })
    expect(signin.status(), await signin.text()).toBe(200)
    await sty.post('/api/auth/organization/set-active', { data: { organizationId: orgId } })
    expect(await can(sty, { pos: ['void'] })).toBe(false)
  })

  test('owner creates a custom role at runtime, and it is listed', async () => {
    const cr = await owner.post('/api/auth/organization/create-role', { data: {
      organizationId: orgId,
      role: 'senior_stylist',
      permission: { booking: ['read', 'create'], pos: ['void'], commission: ['read:own'] },
    } })
    expect(cr.status(), await cr.text()).toBe(200)

    const roleList = await owner.get(`/api/auth/organization/list-roles?organizationId=${orgId}`)
    expect(JSON.stringify(await roleList.json())).toContain('senior_stylist')
  })

  test('assigning the custom role grants void, but not payroll', async () => {
    const assign = await owner.post('/api/auth/organization/update-member-role',
      { data: { organizationId: orgId, memberId: styMemberId, role: 'senior_stylist' } })
    expect(assign.status(), await assign.text()).toBe(200)
    expect(await can(sty, { pos: ['void'] })).toBe(true)
    expect(await can(sty, { payroll: ['run'] })).toBe(false)
  })

  test('front desk cannot create roles', async () => {
    const deskRole = await desk.post('/api/auth/organization/create-role',
      { data: { organizationId: orgId, role: 'sneaky', permission: { pos: ['void'] } } })
    expect(deskRole.status()).toBeGreaterThanOrEqual(400)
  })

  test('a role still assigned to a member cannot be deleted', async () => {
    const delInUse = await owner.post('/api/auth/organization/delete-role',
      { data: { organizationId: orgId, roleName: 'senior_stylist' } })
    expect(delInUse.status()).toBeGreaterThanOrEqual(400)
    expect(JSON.stringify(await delInUse.json())).toContain('ROLE_IS_ASSIGNED_TO_MEMBERS')
  })

  test('reverting to the built-in role revokes void again', async () => {
    const revert = await owner.post('/api/auth/organization/update-member-role',
      { data: { organizationId: orgId, memberId: styMemberId, role: 'stylist' } })
    expect(revert.status(), await revert.text()).toBe(200)
    expect(await can(sty, { pos: ['void'] })).toBe(false)
  })

  test('an unassigned custom role can now be deleted', async () => {
    const delRole = await owner.post('/api/auth/organization/delete-role',
      { data: { organizationId: orgId, roleName: 'senior_stylist' } })
    expect(delRole.status(), await delRole.text()).toBe(200)
  })

  // -------------------------------------------------------- session handling
  // One sign-in for the second device, reused by both tests below (see the
  // rate-limit note at the top of this file) -- exactly like owner2 in the
  // original script.
  test('a second device can sign in, and both sessions are listed', async () => {
    owner2 = await client()
    const second = await owner2.post('/api/auth/sign-in/email',
      { data: { email: `owner@${DOMAIN}`, password: PW } })
    expect(second.status()).toBe(200)

    const list = await owner.get('/api/auth/list-sessions')
    const sessions = await list.json()
    expect(Array.isArray(sessions) && sessions.length >= 2, JSON.stringify(sessions)).toBe(true)
  })

  test('revoking other sessions kills the other device but keeps the current one', async () => {
    const revoked = await owner.post('/api/auth/revoke-other-sessions', { data: {} })
    expect(revoked.status(), await revoked.text()).toBe(200)

    const otherDead = await owner2.get('/api/auth/get-session')
    expect((await otherDead.json())?.user).toBeFalsy()

    const stillAlive = await owner.get('/api/auth/get-session')
    expect((await stillAlive.json())?.user?.email).toBe(`owner@${DOMAIN}`)
    await owner2.dispose()
  })

  // ------------------------------------------------- staff provisioning
  test('front desk cannot provision staff, and an unknown role is rejected at the boundary', async () => {
    const nope = await desk.post('/api/staff',
      { data: { name: 'Nope', email: `nope@${DOMAIN}`, password: PW, role: 'stylist' } })
    expect(nope.status(), await nope.text()).toBe(403)

    const badRole = await owner.post('/api/staff',
      { data: { name: 'Bad', email: `bad@${DOMAIN}`, password: PW, role: 'superuser' } })
    expect(badRole.status(), await badRole.text()).toBe(400)
  })

  test('owner provisions a stylist through /api/staff without hijacking their own session', async () => {
    // provisionStaff (lib/staff.ts) builds the user with internalAdapter's
    // createUser + linkAccount rather than signUpEmail: that endpoint mints a
    // session, and nextCookies() would attach it to THIS response, logging the
    // owner in as the staff member they just created.
    const made = await owner.post('/api/staff',
      { data: { name: 'Putri Ayu', email: `putri@${DOMAIN}`, password: PW, role: 'stylist', branchId: bsd } })
    expect(made.status(), await made.text()).toBe(201)

    const ownerStill = await owner.get('/api/auth/get-session')
    expect((await ownerStill.json())?.user?.email).toBe(`owner@${DOMAIN}`)
  })

  test('the provisioned stylist can sign in with the right permissions and branch', async () => {
    const putri = await client()
    const putriIn = await putri.post('/api/auth/sign-in/email',
      { data: { email: `putri@${DOMAIN}`, password: PW } })
    expect(putriIn.status()).toBe(200)

    await putri.post('/api/auth/organization/set-active', { data: { organizationId: orgId } })
    expect(await can(putri, { booking: ['read'] })).toBe(true)
    expect(await can(putri, { pos: ['checkout'] })).toBe(false)

    const teams = await putri.get('/api/auth/organization/list-user-teams')
    const ids = ((await teams.json()) ?? []).map((t: { id: string }) => t.id)
    expect(ids).toContain(bsd)
    await putri.dispose()
  })

  // ------------------------------------------- auto-scope on session create
  test('a fresh login is scoped to its salon and branch automatically', async () => {
    const fresh = await client()
    await fresh.post('/api/auth/sign-in/email', { data: { email: `putri@${DOMAIN}`, password: PW } })
    const fs = await (await fresh.get('/api/auth/get-session')).json()
    expect(fs?.session?.activeOrganizationId).toBe(orgId)
    expect(fs?.session?.activeTeamId).toBe(bsd)
    expect(await can(fresh, { booking: ['read'] })).toBe(true)
    await fresh.dispose()
  })

  // -------------------------------------------------------------- sign-out
  test('signing out clears the session and its authority', async () => {
    const so = await owner.post('/api/auth/sign-out', { data: {} })
    expect(so.status()).toBe(200)

    const dead = await owner.get('/api/auth/get-session')
    expect((await dead.json())?.user).toBeFalsy()

    const denied = await owner.post('/api/auth/organization/has-permission',
      { data: { permissions: { pos: ['void'] } } })
    expect(denied.status()).toBeGreaterThanOrEqual(400)
  })
})
