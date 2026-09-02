import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { expect, request, test } from '@playwright/test'
import type { BrowserContext, Page } from '@playwright/test'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from '../db'

/**
 * Guards, redirects, form posts, the header switcher's rendered output and
 * the RSC payload, driven over HTTP and a real browser against the running
 * app. Schema, the seeding trigger/backfill and the branch_entitlement
 * view's lock ranking live in tests/branch.db.test.ts instead -- a SQL
 * assertion covers those better than forcing them through Playwright.
 *
 * The Origin header is not optional: better-auth's CSRF check rejects a
 * state-changing call without one (MISSING_OR_NULL_ORIGIN, 403). See
 * tests/e2e/ui.spec.ts.
 */
const DOMAIN = 'branchcheck.local'
const PW = 'demo12345'
const BASE_URL = 'http://localhost:3100'

const pool = new Pool({ connectionString: TEST_DATABASE_URL })

const client = () => request.newContext({
  maxRedirects: 0,
  extraHTTPHeaders: { origin: BASE_URL },
})

// lib/auth.ts rate-limits /sign-up/email to 5 per hour, process-wide -- a
// budget shared with every other e2e spec file, which already spends the
// whole thing (customers.spec.ts x2, plan.spec.ts x2, ui.spec.ts x1). This
// suite bootstraps its owner account without that endpoint: insert the user
// and a real credential account directly (hashed with better-auth's own
// hasher, resolved off its own dependency rather than added as one of ours),
// then sign in normally. /sign-in/email's budget (10/min) has plenty of room.
//
// Loaded lazily inside beforeAll, not at module scope: Playwright transforms
// spec files to CommonJS (see the FREE import below), which supports neither
// top-level await nor import.meta.
let hashPassword: (password: string) => Promise<string>

const createOwnerLogin = async (name: string, email: string, password: string) => {
  const id = randomUUID()
  await pool.query(`
    insert into users (id, name, email, email_verified, created_at, updated_at)
    values ($1, $2, $3, true, now(), now())`, [id, name, email])
  await pool.query(`
    insert into accounts (id, account_id, provider_id, issuer, user_id, password, created_at, updated_at)
    values ($1, $2, 'credential', 'local:credential', $2, $3, now(), now())`,
    [randomUUID(), id, await hashPassword(password)])
  return id
}

const isActive = async (teamId: string) => (await pool.query(
  `select active from branch_profiles where team_id = $1`, [teamId])).rows[0]?.active

const setActive = (teamId: string, active: boolean) => pool.query(
  `update branch_profiles set active = $2 where team_id = $1`, [teamId, active])

/** The Staf cell for one branch, read off the /branches table itself. */
const staffCountOn = async (
  owner: Awaited<ReturnType<typeof client>>, teamId: string,
) => {
  const html = await (await owner.get('/branches')).text()
  const row = html.split('<tr').find((r) => r.includes(`/branches/${teamId}"`))
  const cells = [...(row ?? '').matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => m[1])
  return cells.length ? Number(cells.at(-1)!.replace(/<[^>]*>/g, '')) : null
}

let FREE: { caps: { branches: number } }

test.beforeAll(async () => {
  const { PLANS } = await import('../../scripts/seed-plans.mjs')
  FREE = PLANS.find((p: { key: string }) => p.key === 'free') as typeof FREE
  // @better-auth/utils is better-auth's own dependency, not one of ours, so
  // it is resolved relative to better-auth's own install location (pnpm does
  // not hoist nested dependencies) rather than imported directly.
  const req = createRequire(__filename)
  const resolved = createRequire(req.resolve('better-auth')).resolve('@better-auth/utils/password')
  ;({ hashPassword } = req(resolved))
  await pool.query(`delete from organizations where slug like 'branchcheck%' or id = 'bc_foreign_org'`)
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`])
})

test.afterAll(async () => {
  // Restore from the seed export, never from the live table -- reading the
  // live value after a crashed run is what would launder a corrupted cap
  // forward to the next one.
  await pool.query(`
    insert into plan_limits (plan_id, resource, cap)
    select id, 'branches', $1 from plans where key = 'free'
    on conflict (plan_id, resource) do update set cap = excluded.cap`,
    [FREE.caps.branches])
  await pool.end()
})

test.describe.serial('branch guards, lifecycle and the switcher', () => {
  let owner: Awaited<ReturnType<typeof client>>
  let ownerContext: BrowserContext
  let ownerPage: Page
  let orgId: string
  let t0Id: string // the auto-created default team
  let liveTeam: string // a second branch, becomes the active one once t0 is closed
  let secondTeam: string // a third branch, management-only membership
  let newTeam: string // created through the real UI form
  let deskClient: Awaited<ReturnType<typeof client>> // front desk's one continuing session

  test.beforeAll(async () => { owner = await client() })
  test.afterAll(async () => {
    await owner.dispose()
    await ownerContext?.close()
  })

  test('sign in and create the salon', async () => {
    await createOwnerLogin('Branch Owner', `owner@${DOMAIN}`, PW)
    const signin = await owner.post('/api/auth/sign-in/email',
      { data: { email: `owner@${DOMAIN}`, password: PW } })
    expect(signin.status(), await signin.text()).toBe(200)

    const org = await owner.post('/api/auth/organization/create',
      { data: { name: 'Branch Login', slug: 'branchcheck' } })
    expect(org.status(), await org.text()).toBe(200)
    orgId = (await org.json()).id
    await owner.post('/api/auth/organization/set-active', { data: { organizationId: orgId } })
  })

  test('a fresh login does not land on a deactivated branch', async () => {
    const { rows: [t0] } = await pool.query(
      `select id from teams where organization_id = $1 order by created_at, id limit 1`, [orgId])
    t0Id = t0.id
    const { rows: [ownerUser] } = await pool.query(
      `select id from users where email = $1`, [`owner@${DOMAIN}`])

    liveTeam = 'bc_live1'
    await pool.query(`
      insert into teams (id, name, organization_id, created_at)
      values ($1, 'Cabang Aktif', $2, now())`, [liveTeam, orgId])
    await pool.query(`
      insert into team_members (id, team_id, user_id, created_at)
      values ('bc_tm_live1', $1, $2, now())`, [liveTeam, ownerUser.id])
    await setActive(t0Id, false)

    // Re-sign-in on the SAME context (not a separate one): better-auth issues
    // a new session token and this context's cookie jar picks it up, so every
    // later test in this file keeps building on this one continuing session
    // -- exactly like the "latest session for this user" queries below assume.
    await owner.post('/api/auth/sign-in/email', { data: { email: `owner@${DOMAIN}`, password: PW } })
    const { rows: [sess] } = await pool.query(`
      select s.active_team_id, p.active from sessions s
        join users u on u.id = s.user_id
        left join branch_profiles p on p.team_id = s.active_team_id
       where u.email = $1 order by s.created_at desc limit 1`, [`owner@${DOMAIN}`])
    expect(sess.active_team_id).not.toBe(t0Id)
    expect(sess.active).toBe(true)
  })

  test('switching to a team in another organization is refused', async () => {
    // A genuinely different tenant, inserted directly.
    await pool.query(`
      insert into organizations (id, name, slug, created_at)
      values ('bc_foreign_org', 'Foreign', 'branchcheck-foreign', now())`)
    await pool.query(`
      insert into teams (id, name, organization_id, created_at)
      values ('bc_foreign_team', 'Foreign Team', 'bc_foreign_org', now())`)

    const cross = await owner.post('/api/auth/organization/set-active-team',
      { data: { teamId: 'bc_foreign_team' } })
    expect(cross.status()).toBeGreaterThanOrEqual(400)
  })

  test("switching to a team in the caller's own organization succeeds", async () => {
    const { rows: [ownerUser] } = await pool.query(
      `select id from users where email = $1`, [`owner@${DOMAIN}`])
    secondTeam = 'bc_live2'
    await pool.query(`
      insert into teams (id, name, organization_id, created_at)
      values ($1, 'Cabang Dua', $2, now())`, [secondTeam, orgId])
    await pool.query(`
      insert into team_members (id, team_id, user_id, created_at)
      values ('bc_tm_live2', $1, $2, now())`, [secondTeam, ownerUser.id])

    const same = await owner.post('/api/auth/organization/set-active-team',
      { data: { teamId: secondTeam } })
    expect(same.status(), await same.text()).toBe(200)

    const { rows: [switched] } = await pool.query(`
      select active_team_id from sessions s join users u on u.id = s.user_id
       where u.email = $1 order by s.created_at desc limit 1`, [`owner@${DOMAIN}`])
    expect(switched.active_team_id).toBe(secondTeam)
  })

  test('creating a branch past the cap is refused', async () => {
    // Three teams exist already (t0, liveTeam, secondTeam); countResource
    // counts every team regardless of active, so a cap of 2 is already over.
    await pool.query(`
      insert into plan_limits (plan_id, resource, cap)
      select id, 'branches', 2 from plans where key = 'free'
      on conflict (plan_id, resource) do update set cap = 2`)

    const atCap = await owner.post('/api/auth/organization/create-team',
      { data: { name: 'Cabang Ketiga', organizationId: orgId } })
    expect(atCap.status(), await atCap.text()).toBe(402)
  })

  test('deactivating a branch does NOT free a plan slot — creation still refused', async () => {
    // countResource('branches') counts every team regardless of active, on
    // purpose (a product decision, not a bug): freeing a slot on deactivation
    // would let a salon cycle branches to dodge the cap.
    await setActive(secondTeam, false)

    const stillAtCap = await owner.post('/api/auth/organization/create-team',
      { data: { name: 'Cabang Ketiga', organizationId: orgId } })
    expect(stillAtCap.status(), await stillAtCap.text()).toBe(402)

    await setActive(secondTeam, true)
    // Restore the shared cap now rather than leaving it for a later test to
    // trip over.
    await pool.query(`
      insert into plan_limits (plan_id, resource, cap)
      select id, 'branches', $1 from plans where key = 'free'
      on conflict (plan_id, resource) do update set cap = excluded.cap`, [FREE.caps.branches])
  })

  test('/branches/new refuses at cap instead of rendering a doomed form', async ({ browser }) => {
    ownerContext = await browser.newContext({
      storageState: await owner.storageState(), baseURL: BASE_URL,
    })
    ownerPage = await ownerContext.newPage()

    // Cap is back to 1 (FREE.caps.branches) and the salon already has three
    // teams -- requireQuota counts all of them regardless of active.
    await ownerPage.goto('/branches/new')
    await expect(ownerPage.getByText('Batas cabang paket Anda sudah tercapai')).toBeVisible()
    await expect(ownerPage.getByLabel('Nama cabang')).toHaveCount(0)
  })

  test('a branch created through the UI is switchable by its creator', async () => {
    await pool.query(`
      insert into plan_limits (plan_id, resource, cap)
      select id, 'branches', 5 from plans where key = 'free'
      on conflict (plan_id, resource) do update set cap = 5`)

    await ownerPage.goto('/branches/new')
    await ownerPage.getByLabel('Nama cabang').fill('Cabang Baru')
    await ownerPage.getByLabel('Alamat').fill('Jl. Baru 1')
    await ownerPage.getByLabel('Telepon').fill('02100000')
    await ownerPage.getByRole('button', { name: 'Simpan' }).click()
    await expect(ownerPage).toHaveURL(/\/branches$/)

    const { rows: made } = await pool.query(
      `select id from teams where organization_id = $1 and name = 'Cabang Baru'`, [orgId])
    expect(made).toHaveLength(1)
    newTeam = made[0].id

    const { rows: enrolled } = await pool.query(
      `select 1 from team_members where team_id = $1
         and user_id = (select id from users where email = $2)`,
      [newTeam, `owner@${DOMAIN}`])
    expect(enrolled).toHaveLength(1)

    const entered = await owner.post('/api/auth/organization/set-active-team',
      { data: { teamId: newTeam } })
    expect(entered.status(), await entered.text()).toBe(200)

    const { rows: rank } = await pool.query(
      `select team_id, seq from branch_entitlement where organization_id = $1 order by seq`,
      [orgId])
    expect(rank[0]?.team_id).toBe(liveTeam)
    expect(rank.at(-1)?.team_id).toBe(newTeam)

    // Cap stays at 5 into the next test: provisionStaff (lib/staff.ts)
    // refuses to assign staff into an over_cap branch, and newTeam -- the
    // newest active branch -- would be exactly that at a cap of 1.
  })

  test('front desk is redirected away from /branches, and their assignment counts as staff', async () => {
    // Management membership (the creator's own team_members row, above) is
    // navigational; staff assignment lives in staff_profiles, which
    // assignedStaff() (lib/branch.ts) reads -- a raw team_members insert
    // alone would not make someone "staff" of a branch.
    expect(await staffCountOn(owner, newTeam)).toBe(0)

    // Provisioned through /api/staff (lib/staff.ts) with branchId set, not
    // sign-up + invite-member + accept-invitation: that flow's own coverage
    // lives in plan.spec.ts (invite-member/accept-invitation against a staff
    // cap), and going through it here too would spend more of the
    // process-wide /sign-up/email and /sign-in/email budgets than this suite
    // -- run in the same process as every other spec file -- can afford.
    const provision = await owner.post('/api/staff', {
      data: { name: 'BC Desk', email: `desk@${DOMAIN}`, password: PW, role: 'frontdesk', branchId: newTeam },
    })
    expect(provision.status(), await provision.text()).toBe(201)
    expect(await staffCountOn(owner, newTeam)).toBe(1)

    // One sign-in for the rest of this file: this session's activeTeamId
    // already resolves to newTeam from the team_members row /api/staff just
    // wrote, so the final test below reuses it rather than signing in again.
    deskClient = await client()
    await deskClient.post('/api/auth/sign-in/email', { data: { email: `desk@${DOMAIN}`, password: PW } })

    const res = await deskClient.get('/branches')
    expect(res.status(), `got ${res.status()}`).toBe(307)
    expect(res.headers()['location'] ?? '').toContain('/dashboard')

    // Restore the shared cap now rather than leaving it for a later test.
    await pool.query(`
      insert into plan_limits (plan_id, resource, cap)
      select id, 'branches', $1 from plans where key = 'free'
      on conflict (plan_id, resource) do update set cap = excluded.cap`, [FREE.caps.branches])
  })

  test('deactivation is refused while staff are assigned', async () => {
    await ownerPage.goto(`/branches/${newTeam}`)
    await ownerPage.getByRole('button', { name: 'Nonaktifkan cabang' }).click()
    await expect(ownerPage.getByText('Pindahkan staf berikut lebih dulu: BC Desk.')).toBeVisible()
    expect(await isActive(newTeam)).toBe(true)
  })

  test('a branch whose only members are management can be deactivated', async () => {
    await ownerPage.goto(`/branches/${secondTeam}`)
    await ownerPage.getByRole('button', { name: 'Nonaktifkan cabang' }).click()
    // The page must come back showing the NEW state, not the button that was
    // clicked -- the regression this guards is a write that lands with no
    // visible sign, so a second click errors about state the first click
    // itself created.
    await expect(ownerPage.getByRole('button', { name: 'Aktifkan cabang' })).toBeVisible()
    await expect(ownerPage.getByRole('button', { name: 'Nonaktifkan cabang' })).toHaveCount(0)
    expect(await isActive(secondTeam)).toBe(false)

    await ownerPage.getByRole('button', { name: 'Aktifkan cabang' }).click()
    await expect(ownerPage.getByRole('button', { name: 'Nonaktifkan cabang' })).toBeVisible()
    expect(await isActive(secondTeam)).toBe(true)
  })

  test('the last open branch cannot be closed', async () => {
    await setActive(newTeam, false)
    await setActive(secondTeam, false)
    const { rows: open } = await pool.query(`
      select p.team_id from branch_profiles p join teams t on t.id = p.team_id
       where t.organization_id = $1 and p.active`, [orgId])
    expect(open).toHaveLength(1)
    expect(open[0].team_id).toBe(liveTeam)

    await ownerPage.goto(`/branches/${liveTeam}`)
    await ownerPage.getByRole('button', { name: 'Nonaktifkan cabang' }).click()
    await expect(ownerPage.getByText('Ini satu-satunya cabang aktif')).toBeVisible()
    expect(await isActive(liveTeam)).toBe(true)

    await setActive(newTeam, true)
    await setActive(secondTeam, true)
  })

  test('a closed branch stays in the switcher, flagged inactive', async () => {
    // t0 has been closed since the very first test in this file. The switcher
    // is a client component whose items render lazily on open, so what this
    // reads is the RSC payload the layout handed it -- the branches prop.
    const html = await (await owner.get('/dashboard')).text()
    const m = html.replace(/\\+"/g, '"').match(new RegExp(`\\{"teamId":"${t0Id}"[^}]*\\}`))
    expect(m).toBeTruthy()
    expect(JSON.parse(m![0]).active).toBe(false)
  })

  test('a closed branch is still selectable', async () => {
    const entered = await owner.post('/api/auth/organization/set-active-team',
      { data: { teamId: t0Id } })
    expect(entered.status(), await entered.text()).toBe(200)
    // Switch back to a live branch so later reads of /dashboard aren't
    // themselves standing in a closed branch.
    await owner.post('/api/auth/organization/set-active-team', { data: { teamId: liveTeam } })
  })

  test("front desk sees their own branch, and never the salon's full list", async () => {
    const html = await (await deskClient.get('/dashboard')).text()
    expect(html).toContain('Cabang Baru')
    expect(html).not.toContain('Cabang Dua')
    expect(html).not.toContain('withinCap')
    await deskClient.dispose()
  })
})
