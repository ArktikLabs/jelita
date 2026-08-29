/**
 * End-to-end auth check. No framework on purpose.
 *   pnpm auth:check      (dev server must be running)
 *
 * Covers: sign-up, sign-in, sign-out, session, change-password,
 * forgot/reset password, invitations, role assignment, role reassignment,
 * branch (team) assignment, and per-role permission enforcement.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { Pool } from 'pg'

const BASE = `${process.env.BETTER_AUTH_URL}/api/auth`
const APP = `${process.env.BETTER_AUTH_URL}/api`
const ORIGIN = process.env.BETTER_AUTH_URL
const DOMAIN = 'authcheck.local'
const PW = 'demo12345'

let pass = 0, fail = 0
const ok = (n, c, d) => (c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${n}`))
                           : (fail++, console.log(`  \x1b[31m✗\x1b[0m ${n}  ${d ?? ''}`)))
const head = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`)

class Client {
  constructor() { this.jar = new Map() }
  async req(path, body, method = 'POST', base = BASE) {
    const headers = { 'content-type': 'application/json', origin: ORIGIN }
    if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ')
    // better-auth rejects a POST that declares JSON but sends no body
    // ("Invalid JSON in request body"), so empty POSTs must send {}.
    const res = await fetch(base + path, {
      method,
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    })
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const kv = c.split(';')[0], i = kv.indexOf('=')
      const name = kv.slice(0, i), val = kv.slice(i + 1)
      if (val === '') this.jar.delete(name)
      else this.jar.set(name, val)
    }
    const txt = await res.text()
    let data; try { data = JSON.parse(txt) } catch { data = txt }
    return { status: res.status, data }
  }
  get(p) { return this.req(p, undefined, 'GET') }
}

const can = async (c, permissions) =>
  (await c.req('/organization/has-permission', { permissions })).data?.success === true

const pool = new Pool({ connectionString: process.env.DIRECT_URL })

try {
  head('0. reset test fixtures')
  await pool.query(`delete from organizations where slug = 'authcheck'`)
  const del = await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`])
  writeFileSync('.mail.log', '')
  ok(`cleared ${del.rowCount} prior test user(s)`, true)

  // ---------------------------------------------------------------- sign-up
  head('1. sign-up / sign-in / session / sign-out')
  const owner = new Client(), desk = new Client(), sty = new Client()
  const su = async (c, name, email) =>
    (await c.req('/sign-up/email', { name, email, password: PW })).status
  ok('owner sign-up', await su(owner, 'Aan Owner', `owner@${DOMAIN}`) === 200)
  ok('frontdesk sign-up', await su(desk, 'Rani Kasir', `kasir@${DOMAIN}`) === 200)
  ok('stylist sign-up', await su(sty, 'Sinta Stylist', `sinta@${DOMAIN}`) === 200)

  const weak = await new Client().req('/sign-up/email',
    { name: 'X', email: `weak@${DOMAIN}`, password: 'short' })
  ok('short password rejected (min 8)', weak.status >= 400, `got ${weak.status}`)

  const dup = await new Client().req('/sign-up/email',
    { name: 'X', email: `owner@${DOMAIN}`, password: PW })
  ok('duplicate email rejected', dup.status >= 400, `got ${dup.status}`)

  const sess = await owner.get('/get-session')
  ok('session readable after sign-up', sess.data?.user?.email === `owner@${DOMAIN}`)

  const badPw = await new Client().req('/sign-in/email',
    { email: `owner@${DOMAIN}`, password: 'wrongpassword' })
  ok('wrong password rejected', badPw.status >= 400, `got ${badPw.status}`)

  // ------------------------------------------------------------- tenancy
  head('2. tenancy: organization = salon, team = branch')
  const org = await owner.req('/organization/create',
    { name: 'Jelita Authcheck', slug: 'authcheck' })
  const orgId = org.data?.id
  ok('organization created', !!orgId, JSON.stringify(org.data).slice(0, 120))
  await owner.req('/organization/set-active', { organizationId: orgId })

  const mkTeam = async (name) =>
    (await owner.req('/organization/create-team', { name, organizationId: orgId })).data?.id
  const kemang = await mkTeam('Kemang')
  const bsd = await mkTeam('BSD')
  ok('two branches created as teams', !!kemang && !!bsd)

  const role = await owner.get('/organization/get-active-member-role')
  ok('creator got owner role', JSON.stringify(role.data).includes('owner'), JSON.stringify(role.data))

  // --------------------------------------------------- invite + assign role
  head('3. invitation + role assignment + branch assignment')
  const invite = async (email, r, teamId) =>
    await owner.req('/organization/invite-member',
      { email, role: r, organizationId: orgId, ...(teamId ? { teamId } : {}) })

  const i1 = await invite(`kasir@${DOMAIN}`, 'frontdesk', kemang)
  ok('frontdesk invited with role+branch', i1.status === 200, JSON.stringify(i1.data).slice(0, 160))
  const a1 = await desk.req('/organization/accept-invitation', { invitationId: i1.data?.id })
  ok('frontdesk accepted invitation', a1.status === 200, JSON.stringify(a1.data).slice(0, 160))

  const i2 = await invite(`sinta@${DOMAIN}`, 'stylist', kemang)
  const a2 = await sty.req('/organization/accept-invitation', { invitationId: i2.data?.id })
  ok('stylist invited + accepted', i2.status === 200 && a2.status === 200)

  ok('invitation email dispatched', readFileSync('.mail.log', 'utf8').includes('Undangan bergabung'))

  const members = await owner.get(`/organization/list-members?organizationId=${orgId}`)
  const byRole = Object.fromEntries(
    (members.data?.members ?? []).map((m) => [m.user?.email, m.role]))
  ok('roles persisted on members', byRole[`kasir@${DOMAIN}`] === 'frontdesk'
    && byRole[`sinta@${DOMAIN}`] === 'stylist', JSON.stringify(byRole))

  await desk.req('/organization/set-active', { organizationId: orgId })
  await sty.req('/organization/set-active', { organizationId: orgId })

  const addT = await owner.req('/organization/add-team-member',
    { teamId: bsd, userId: (members.data?.members ?? [])
      .find((m) => m.user?.email === `sinta@${DOMAIN}`)?.userId })
  ok('stylist assigned to a second branch', addT.status === 200, JSON.stringify(addT.data).slice(0, 140))

  const deskTeams = await desk.get('/organization/list-user-teams')
  const deskTeamIds = (deskTeams.data ?? []).map((t) => t.id)
  ok('frontdesk is scoped to exactly one branch (§5.8)',
    deskTeamIds.length === 1 && deskTeamIds[0] === kemang, JSON.stringify(deskTeamIds))

  // ------------------------------------------------------------ permissions
  head('4. permission enforcement per role')
  ok('owner CAN void a transaction', await can(owner, { pos: ['void'] }))
  ok('owner CAN run payroll', await can(owner, { payroll: ['run'] }))
  ok('frontdesk CAN checkout', await can(desk, { pos: ['checkout'] }))
  ok('frontdesk CANNOT void (§5.2 immutability)', !(await can(desk, { pos: ['void'] })))
  ok('frontdesk CANNOT read payroll', !(await can(desk, { payroll: ['read'] })))
  ok('frontdesk CANNOT manage staff', !(await can(desk, { staff: ['create'] })))
  ok('stylist CAN read bookings', await can(sty, { booking: ['read'] }))
  ok('stylist CANNOT checkout', !(await can(sty, { pos: ['checkout'] })))
  ok('stylist CANNOT read all commissions', !(await can(sty, { commission: ['read'] })))
  ok('stylist CAN read own commission', await can(sty, { commission: ['read:own'] }))

  const escalate = await desk.req('/organization/update-member-role',
    { organizationId: orgId, memberId: (members.data?.members ?? [])
      .find((m) => m.user?.email === `sinta@${DOMAIN}`)?.id, role: 'owner' })
  ok('frontdesk CANNOT escalate a role', escalate.status >= 400, `got ${escalate.status}`)

  // --------------------------------------------------------- role reassign
  head('5. role reassignment takes effect immediately')
  const deskMemberId = (members.data?.members ?? [])
    .find((m) => m.user?.email === `kasir@${DOMAIN}`)?.id
  const promote = await owner.req('/organization/update-member-role',
    { organizationId: orgId, memberId: deskMemberId, role: 'admin' })
  ok('owner promoted frontdesk → admin', promote.status === 200, JSON.stringify(promote.data).slice(0, 140))
  ok('promoted user CAN now void', await can(desk, { pos: ['void'] }))
  await owner.req('/organization/update-member-role',
    { organizationId: orgId, memberId: deskMemberId, role: 'frontdesk' })
  ok('demoted back → void revoked again', !(await can(desk, { pos: ['void'] })))

  // ------------------------------------------------------- change password
  head('6. change password')
  const badChange = await desk.req('/change-password',
    { currentPassword: 'wrongpassword', newPassword: 'newpass12345' })
  ok('change rejected with wrong current password', badChange.status >= 400, `got ${badChange.status}`)

  const goodChange = await desk.req('/change-password',
    { currentPassword: PW, newPassword: 'newpass12345', revokeOtherSessions: true })
  ok('change accepted with correct current password', goodChange.status === 200,
    JSON.stringify(goodChange.data).slice(0, 140))

  const oldLogin = await new Client().req('/sign-in/email',
    { email: `kasir@${DOMAIN}`, password: PW })
  ok('old password no longer works', oldLogin.status >= 400, `got ${oldLogin.status}`)
  const newLogin = await new Client().req('/sign-in/email',
    { email: `kasir@${DOMAIN}`, password: 'newpass12345' })
  ok('new password works', newLogin.status === 200)

  // ------------------------------------------------------- forgot password
  head('7. forgot / reset password')
  writeFileSync('.mail.log', '')
  const fp = await new Client().req('/request-password-reset',
    { email: `sinta@${DOMAIN}`, redirectTo: `${ORIGIN}/reset-password` })
  ok('reset requested', fp.status === 200, JSON.stringify(fp.data).slice(0, 140))

  await new Promise((r) => setTimeout(r, 700))
  const log = readFileSync('.mail.log', 'utf8')
  const token = log.match(/token=([A-Za-z0-9._-]+)/)?.[1]
  ok('reset token delivered to mail transport', !!token, log.slice(0, 200))

  const reset = await new Client().req('/reset-password',
    { newPassword: 'resetpass12345', token })
  ok('password reset with token', reset.status === 200, JSON.stringify(reset.data).slice(0, 140))

  const afterReset = await new Client().req('/sign-in/email',
    { email: `sinta@${DOMAIN}`, password: 'resetpass12345' })
  ok('sign-in with reset password', afterReset.status === 200)

  const reuse = await new Client().req('/reset-password',
    { newPassword: 'anotherpass123', token })
  ok('reset token cannot be reused', reuse.status >= 400, `got ${reuse.status}`)

  // ------------------------------------------- dynamic AC ("assign permission")
  head('9. runtime custom roles (assign permission without a redeploy)')
  const sty2 = new Client()
  await sty2.req('/sign-in/email', { email: `sinta@${DOMAIN}`, password: 'resetpass12345' })
  await sty2.req('/organization/set-active', { organizationId: orgId })
  ok('stylist (post-reset) still CANNOT void', !(await can(sty2, { pos: ['void'] })))

  const cr = await owner.req('/organization/create-role', {
    organizationId: orgId,
    role: 'senior_stylist',
    permission: { booking: ['read', 'create'], pos: ['void'], commission: ['read:own'] },
  })
  ok('owner created a custom role at runtime', cr.status === 200, JSON.stringify(cr.data).slice(0, 160))

  const roleList = await owner.get(`/organization/list-roles?organizationId=${orgId}`)
  ok('custom role is listed', JSON.stringify(roleList.data).includes('senior_stylist'),
    JSON.stringify(roleList.data).slice(0, 160))

  const styMember = (members.data?.members ?? []).find((m) => m.user?.email === `sinta@${DOMAIN}`)
  const assign = await owner.req('/organization/update-member-role',
    { organizationId: orgId, memberId: styMember?.id, role: 'senior_stylist' })
  ok('custom role assigned to stylist', assign.status === 200, JSON.stringify(assign.data).slice(0, 160))

  ok('stylist with custom role CAN now void', await can(sty2, { pos: ['void'] }))
  ok('custom role still CANNOT run payroll', !(await can(sty2, { payroll: ['run'] })))

  const deskRole = await desk.req('/organization/create-role', {
    organizationId: orgId, role: 'sneaky', permission: { pos: ['void'] },
  })
  ok('frontdesk CANNOT create roles', deskRole.status >= 400, `got ${deskRole.status}`)

  const delInUse = await owner.req('/organization/delete-role',
    { organizationId: orgId, roleName: 'senior_stylist' })
  ok('a role still assigned to members CANNOT be deleted',
    delInUse.status >= 400 && JSON.stringify(delInUse.data).includes('ROLE_IS_ASSIGNED_TO_MEMBERS'),
    `got ${delInUse.status}`)

  await owner.req('/organization/update-member-role',
    { organizationId: orgId, memberId: styMember?.id, role: 'stylist' })
  ok('stylist reverted to built-in role → void revoked', !(await can(sty2, { pos: ['void'] })))

  const delRole = await owner.req('/organization/delete-role',
    { organizationId: orgId, roleName: 'senior_stylist' })
  ok('unassigned custom role deleted', delRole.status === 200, JSON.stringify(delRole.data).slice(0, 160))

  // -------------------------------------------------------- session handling
  head('10. session management')
  const owner2 = new Client()
  const second = await owner2.req('/sign-in/email', { email: `owner@${DOMAIN}`, password: PW })
  ok('second device signed in', second.status === 200)

  const list = await owner.get('/list-sessions')
  ok('sessions are listable', Array.isArray(list.data) && list.data.length >= 2,
    JSON.stringify(list.data).slice(0, 120))

  const revoked = await owner.req('/revoke-other-sessions')
  ok('revoke-other-sessions accepted', revoked.status === 200, JSON.stringify(revoked.data).slice(0, 120))

  const otherDead = await owner2.get('/get-session')
  ok('other device session was revoked', !otherDead.data?.user)
  const stillAlive = await owner.get('/get-session')
  ok('current session survived the revoke', stillAlive.data?.user?.email === `owner@${DOMAIN}`)

  // ------------------------------------------------- staff provisioning
  head('11. staff provisioning (tenant-scoped, no email round-trip)')
  const nope = await desk.req('/staff', {
    name: 'Nope', email: `nope@${DOMAIN}`, password: PW, role: 'stylist',
  }, 'POST', APP)
  ok('frontdesk CANNOT provision staff', nope.status === 403,
    `got ${nope.status} ${JSON.stringify(nope.data)}`)

  const badRole = await owner.req('/staff', {
    name: 'Bad', email: `bad@${DOMAIN}`, password: PW, role: 'superuser',
  }, 'POST', APP)
  ok('unknown role rejected at the boundary', badRole.status === 400, `got ${badRole.status}`)

  const made = await owner.req('/staff', {
    name: 'Putri Ayu', email: `putri@${DOMAIN}`, password: PW,
    role: 'stylist', branchId: bsd,
  }, 'POST', APP)
  ok('owner provisioned a stylist', made.status === 201, JSON.stringify(made.data).slice(0, 160))

  const ownerStill = await owner.get('/get-session')
  ok("owner's session NOT hijacked by the new signup",
    ownerStill.data?.user?.email === `owner@${DOMAIN}`,
    JSON.stringify(ownerStill.data?.user?.email))

  const putri = new Client()
  const putriIn = await putri.req('/sign-in/email', { email: `putri@${DOMAIN}`, password: PW })
  ok('provisioned staff can sign in', putriIn.status === 200)
  await putri.req('/organization/set-active', { organizationId: orgId })
  ok('provisioned staff has stylist permissions', await can(putri, { booking: ['read'] }))
  ok('provisioned staff CANNOT checkout', !(await can(putri, { pos: ['checkout'] })))

  const putriTeams = await putri.get('/organization/list-user-teams')
  ok('provisioned staff landed in the requested branch',
    (putriTeams.data ?? []).map((t) => t.id).includes(bsd),
    JSON.stringify(putriTeams.data))

  // ------------------------------------------- auto-scope on session create
  head('12. a fresh login is scoped to its salon + branch automatically')
  const fresh = new Client()
  await fresh.req('/sign-in/email', { email: `putri@${DOMAIN}`, password: PW })
  const fs2 = await fresh.get('/get-session')
  ok('new session has an active organization (no set-active call)',
    fs2.data?.session?.activeOrganizationId === orgId,
    JSON.stringify(fs2.data?.session?.activeOrganizationId))
  ok('new session has an active branch',
    fs2.data?.session?.activeTeamId === bsd,
    JSON.stringify(fs2.data?.session?.activeTeamId))
  ok('permissions work immediately after login', await can(fresh, { booking: ['read'] }))

  // -------------------------------------------------------------- sign-out
  head('8. sign-out')
  const so = await owner.req('/sign-out')
  ok('sign-out returns 200', so.status === 200)
  const dead = await owner.get('/get-session')
  ok('session is gone after sign-out', !dead.data?.user, JSON.stringify(dead.data).slice(0, 120))
  const denied = await owner.req('/organization/has-permission', { permissions: { pos: ['void'] } })
  ok('signed-out user cannot check permissions', denied.status >= 400, `got ${denied.status}`)
} catch (e) {
  fail++
  console.error('\n\x1b[31mFATAL\x1b[0m', e.stack)
} finally {
  await pool.end()
}

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`)
process.exit(fail ? 1 : 0)
