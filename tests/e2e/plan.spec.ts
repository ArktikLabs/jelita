import { expect, request, test } from '@playwright/test'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from '../db'
import { BASE_URL } from './fixtures'

/**
 * Entitlement resolution and quota enforcement, driven over HTTP against the
 * running app. Schema, constraints, triggers and catalogue integrity live in
 * tests/plan.db.test.ts instead -- a SQL assertion covers those better than
 * forcing them through Playwright.
 *
 * The Origin header is not optional: better-auth's CSRF check rejects a
 * state-changing call without one (MISSING_OR_NULL_ORIGIN, 403). See
 * tests/e2e/ui.spec.ts.
 */
const DOMAIN = 'planflow.local'
const PW = 'demo12345'


const pool = new Pool({ connectionString: TEST_DATABASE_URL })

const client = () => request.newContext({ extraHTTPHeaders: { origin: BASE_URL } })

const verify = (email: string) => pool.query(
  `update users set email_verified = true where email = $1`, [email])

// scripts/seed-plans.mjs is a real ES module (it needs import.meta for its
// entry-point guard); Playwright transforms test files to CommonJS, and a
// static `import` of an .mjs from there breaks on that guard. A real dynamic
// import still resolves it correctly, so FREE is loaded lazily instead of at
// module scope -- the alternative, copying its numbers as literals here,
// is exactly the drift scripts/seed-plans.mjs's own comment warns about.
let FREE: { caps: { branches: number, staff: number } }

test.beforeAll(async () => {
  const { PLANS } = await import('../../scripts/seed-plans.mjs')
  FREE = PLANS.find((p: { key: string }) => p.key === 'free') as typeof FREE
  await pool.query(`delete from organizations where slug like 'planflow%'`)
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`])
})

test.afterAll(async () => {
  // Restore from the seed export, never from the live table: reading the
  // live value after a crashed run is what would launder a corrupted cap
  // forward to the next one.
  await pool.query(`
    insert into plan_limits (plan_id, resource, cap)
    select id, 'staff', $1 from plans where key = 'free'
    on conflict (plan_id, resource) do update set cap = excluded.cap`,
    [FREE.caps.staff])
  await pool.end()
})

test.describe.serial('entitlement resolution and quota enforcement', () => {
  let owner: Awaited<ReturnType<typeof client>>
  let orgId: string
  let org2Id: string
  let staffCap: number
  let inviteId: string

  test.beforeAll(async () => { owner = await client() })
  test.afterAll(() => owner.dispose())

  const addStaff = (email: string, name: string) => owner.post('/api/staff',
    { data: { name, email, password: PW, role: 'stylist' } })

  test('a new tenant resolves entitlements for its default plan', async () => {
    const signup = await owner.post('/api/auth/sign-up/email',
      { data: { name: 'Plan Owner', email: `owner@${DOMAIN}`, password: PW } })
    expect(signup.status()).toBe(200)
    await verify(`owner@${DOMAIN}`)
    await owner.post('/api/auth/sign-in/email', { data: { email: `owner@${DOMAIN}`, password: PW } })

    const org = await owner.post('/api/auth/organization/create',
      { data: { name: 'Plan Flow Salon', slug: 'planflow' } })
    expect(org.status(), await org.text()).toBe(200)
    orgId = (await org.json()).id
    await owner.post('/api/auth/organization/set-active', { data: { organizationId: orgId } })

    const ent = await owner.get('/api/me/entitlements')
    expect(ent.status()).toBe(200)
    expect((await ent.json()).planKey).toBe('free')
  })

  test('free tier grants online_booking', async () => {
    const ent = await (await owner.get('/api/me/entitlements')).json()
    expect(ent.features).toContain('online_booking')
  })

  test('free tier does NOT grant payroll', async () => {
    const ent = await (await owner.get('/api/me/entitlements')).json()
    expect(ent.features).not.toContain('payroll')
  })

  test('free tier caps branches at the seeded value', async () => {
    const ent = await (await owner.get('/api/me/entitlements')).json()
    expect(ent.caps.branches).toBe(FREE.caps.branches)
  })

  // free caps staff at FREE.caps.staff; the owner already occupies one seat.
  test('staff can be added while under cap', async () => {
    const s1 = await addStaff(`s1@${DOMAIN}`, 'Staff 1')
    const s2 = await addStaff(`s2@${DOMAIN}`, 'Staff 2')
    expect(s1.status()).toBe(201)
    expect(s2.status()).toBe(201)
  })

  test('staff creation past the cap returns 402', async () => {
    const s3 = await addStaff(`s3@${DOMAIN}`, 'Staff 3')
    expect(s3.status()).toBe(402)
  })

  test('the 402 body names the resource, cap and usage', async () => {
    const s3 = await addStaff(`s3b@${DOMAIN}`, 'Staff 3b')
    const body = await s3.json()
    expect(body).toMatchObject({
      error: 'QUOTA_EXCEEDED', resource: 'staff', cap: FREE.caps.staff, used: FREE.caps.staff,
    })
  })

  test('upgrading to an uncapped tier allows creation again', async () => {
    await pool.query(`
      update subscriptions set plan_id = (select id from plans where key = 'business')
       where organization_id = $1`, [orgId])
    const s4 = await addStaff(`s4@${DOMAIN}`, 'Staff 4')
    expect(s4.status(), await s4.text()).toBe(201)
    await pool.query(`
      update subscriptions set plan_id = (select id from plans where key = 'free')
       where organization_id = $1`, [orgId])
  })

  // free caps branches at 1, and the org's auto-created team is branch #1.
  const createTeam = (organizationId: string, name: string) => owner.post(
    '/api/auth/organization/create-team', { data: { name, organizationId } })

  test('creating a branch past the cap is refused', async () => {
    const extraTeam = await createTeam(orgId, 'Second Branch')
    expect(extraTeam.status(), await extraTeam.text()).toBe(402)
  })

  test('the same call succeeds on a tier with room', async () => {
    await pool.query(`
      update subscriptions set plan_id = (select id from plans where key = 'pro')
       where organization_id = $1`, [orgId])
    const allowed = await createTeam(orgId, 'Second Branch')
    expect(allowed.status(), await allowed.text()).toBe(200)
    await pool.query(`
      update subscriptions set plan_id = (select id from plans where key = 'free')
       where organization_id = $1`, [orgId])
  })

  test("the caller's active org can move to an uncapped second salon", async () => {
    const org2 = await owner.post('/api/auth/organization/create',
      { data: { name: 'Plan Flow Salon 2', slug: 'planflow2' } })
    org2Id = (await org2.json()).id
    await pool.query(`
      update subscriptions set plan_id = (select id from plans where key = 'business')
       where organization_id = $1`, [org2Id])
    const active2 = await owner.post('/api/auth/organization/set-active',
      { data: { organizationId: org2Id } })
    expect((await active2.json()).id).toBe(org2Id)
  })

  test("create-team is quota-checked against the body's organizationId, not the active org", async () => {
    // better-auth resolves the target org as `ctx.body.organizationId ||
    // session.activeOrganizationId`, so the quota must be charged to the org
    // in the BODY. An owner whose ACTIVE salon is uncapped must still not be
    // able to create a branch in a capped salon they also belong to.
    const crossOrg = await createTeam(orgId, 'Cross Org Branch')
    expect(crossOrg.status(), await crossOrg.text()).toBe(402)
    const body = await crossOrg.json()
    expect(body).toMatchObject({ error: 'QUOTA_EXCEEDED', resource: 'branches' })

    await owner.post('/api/auth/organization/set-active', { data: { organizationId: orgId } })
  })

  test('unauthenticated create-team returns 401, not 500', async () => {
    // A guard that throws a non-APIError from a global before-hook surfaces
    // as a bodyless 500; the endpoint's own session check must be what
    // answers here.
    const anon = await client()
    const anonTeam = await anon.post('/api/auth/organization/create-team',
      { data: { name: 'Nobody Branch', organizationId: orgId } })
    expect(anonTeam.status(), await anonTeam.text()).toBe(401)
    await anon.dispose()
  })

  test('invite-member succeeds while a seat remains', async () => {
    // Pin free's staff cap to exactly one seat above the org's current
    // member count, so there is precisely one free seat to invite into and
    // then fill -- the exact boundary the accept-invitation org-resolution
    // fix depends on.
    const { rows: [{ n }] } = await pool.query(
      `select count(*)::int as n from members where organization_id = $1`, [orgId])
    staffCap = n + 1
    await pool.query(`
      update plan_limits set cap = $1
       where plan_id = (select id from plans where key = 'free') and resource = 'staff'`,
      [staffCap])

    const invitee = await client()
    await invitee.post('/api/auth/sign-up/email',
      { data: { name: 'Plan Invitee', email: `invitee@${DOMAIN}`, password: PW } })
    await verify(`invitee@${DOMAIN}`)
    await invitee.dispose()

    const inv1 = await owner.post('/api/auth/organization/invite-member',
      { data: { email: `invitee@${DOMAIN}`, role: 'stylist', organizationId: orgId } })
    expect(inv1.status(), await inv1.text()).toBe(200)
    inviteId = (await inv1.json()).id
  })

  test('filling the last seat succeeds', async () => {
    const filler = await addStaff(`filler@${DOMAIN}`, 'Filler')
    expect(filler.status(), await filler.text()).toBe(201)
  })

  test("accept-invitation is refused once the invitation's org is at its staff cap", async () => {
    const invitee = await client()
    await invitee.post('/api/auth/sign-in/email', { data: { email: `invitee@${DOMAIN}`, password: PW } })
    const acceptAtCap = await invitee.post('/api/auth/organization/accept-invitation',
      { data: { invitationId: inviteId } })
    expect(acceptAtCap.status(), await acceptAtCap.text()).toBe(402)
    const body = await acceptAtCap.json()
    expect(body).toMatchObject({
      error: 'QUOTA_EXCEEDED', resource: 'staff', cap: staffCap, used: staffCap,
    })
    await invitee.dispose()
  })

  test('invite-member is refused (courtesy check) once staff is at cap', async () => {
    const inviteAtCap = await owner.post('/api/auth/organization/invite-member',
      { data: { email: `invitee2@${DOMAIN}`, role: 'stylist', organizationId: orgId } })
    expect(inviteAtCap.status(), await inviteAtCap.text()).toBe(402)
    const body = await inviteAtCap.json()
    expect(body).toMatchObject({
      error: 'QUOTA_EXCEEDED', resource: 'staff', cap: staffCap, used: staffCap,
    })
  })
})
