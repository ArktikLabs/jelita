import { expect, request, test } from '@playwright/test'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from '../db'
import { createSalon, createLogin, signIn, BASE_URL } from './fixtures'

/**
 * Guards, redirects, form posts, provisioning (the JSON API and both Server
 * Action paths), the assignment model, departure and the bulk import --
 * driven over HTTP against the running app. Schema, the seeding
 * trigger/backfill, countResource('staff') SQL facts and the two
 * ownerless-salon concurrency guards live in tests/staff.db.test.ts instead.
 * The branch_entitlement view's lock ranking and getBranchStatus's
 * closed-beats-over_cap precedence are already proven in
 * tests/branch.db.test.ts -- this file only proves how STAFF actions apply
 * that guard (branchWriteError in app/dashboard/(shell)/staff/actions.ts).
 *
 * The Origin header is not optional: better-auth's CSRF check rejects a
 * state-changing call without one (MISSING_OR_NULL_ORIGIN, 403). See
 * tests/e2e/ui.spec.ts.
 */
const DOMAIN = 'staffcheck.local'
const PW = 'demo12345'


const pool = new Pool({ connectionString: TEST_DATABASE_URL })

const client = () => request.newContext({
  maxRedirects: 0,
  extraHTTPHeaders: { origin: BASE_URL },
})

const setPlan = (organizationId: string, key: string) => pool.query(`
  update subscriptions set plan_id = (select id from plans where key = $2)
   where organization_id = $1`, [organizationId, key])

const defaultTeamOf = async (organizationId: string) => (await pool.query(
  `select id from teams where organization_id = $1 order by created_at limit 1`,
  [organizationId])).rows[0].id as string

const setDefaultStaffCap = (cap: number) => pool.query(`
  insert into plan_limits (plan_id, resource, cap)
  select id, 'staff', $1 from plans where is_default
  on conflict (plan_id, resource) do update set cap = excluded.cap`, [cap])

/**
 * Server actions render as plain, no-JS-fallback HTML forms -- a hidden
 * input per bound argument -- so a real POST needs those hidden fields
 * copied through verbatim. Ported from the shell script this suite replaces
 * (scripts/staff-check.mjs), which discovered this shape the same way: by
 * running it. Same helpers as tests/e2e/service.spec.ts.
 */
const decodeHtml = (t: string) => t.replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

const getPage = async (ctx: Awaited<ReturnType<typeof client>>, path: string) => {
  const r = await ctx.get(path)
  return { status: r.status(), html: await r.text() }
}

const hiddenFieldsOf = (formChunk: string) => [...formChunk.slice(0, formChunk.indexOf('</form>')).matchAll(
  /<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?\s*\/>/g)]

const submitForm = async (
  ctx: Awaited<ReturnType<typeof client>>, path: string, marker: string,
  fields: Record<string, string> = {},
) => {
  const page = await getPage(ctx, path)
  const form = page.html.split('<form').find((f) => f.includes(marker))
  if (!form) throw new Error(`no form matching ${marker} on ${path} (status ${page.status})`)
  const multipart: Record<string, string> = {}
  for (const [, k, v] of hiddenFieldsOf(form)) multipart[decodeHtml(k)] = decodeHtml(v ?? '')
  Object.assign(multipart, fields)
  const r = await ctx.post(path, { multipart, maxRedirects: 0 })
  return { status: r.status(), location: r.headers()['location'], html: await r.text() }
}

/** Follows redirects up to `cap` hops and requires the chain to TERMINATE --
 *  a single-hop check cannot see a loop (see the "deactivated login" tests
 *  below). */
const followed = async (
  ctx: Awaited<ReturnType<typeof client>>, path: string, cap = 8,
) => {
  const hops: string[] = []
  let url = path
  for (let i = 0; i < cap; i++) {
    const r = await ctx.get(url)
    if (r.status() < 300 || r.status() > 399) return { status: r.status(), url, hops }
    const loc = r.headers()['location'] ?? ''
    hops.push(loc)
    url = loc
  }
  return { status: null, url, hops }
}

const CLOSED_MSG = 'Cabang ini nonaktif. Aktifkan dulu sebelum menempatkan staf.'
const OVERCAP_MSG = 'Cabang ini terkunci oleh batas paket. Upgrade untuk menempatkan staf.'
const BRANCH_NOT_FOUND_MSG = 'Cabang tidak ditemukan.'
const LAST_OWNER_MSG = 'Ini pemilik terakhir yang aktif. Tunjuk pemilik lain lebih dulu.'
const SELF_MSG = 'Anda tidak dapat menonaktifkan akun Anda sendiri.'
const QUOTA_REACTIVATE_MSG = 'Kuota staf paket Anda sudah tercapai. Upgrade untuk mengaktifkan kembali.'
const NEWPW = 'demo987654'

// A foreign salon's branch, for every "another salon's id must read as
// not-found, never leak status" check below. A real org AND a real team --
// not a bare row missing something a join needs (tests/README.md's own trap).
const FOREIGN_ORG = 'stf_foreign_org'
const FOREIGN_TEAM = 'stf_foreign_team'
const FOREIGN_USER = 'stf_foreign_user'

let FREE: { caps: { staff: number } }

test.beforeAll(async () => {
  const { PLANS } = await import('../../scripts/seed-plans.mjs')
  FREE = PLANS.find((p: { key: string }) => p.key === 'free') as typeof FREE
  await pool.query(`delete from organizations where slug like 'staffcheck%' or id = $1`, [FOREIGN_ORG])
  await pool.query(`delete from users where email like $1 or id = $2`, [`%@${DOMAIN}`, FOREIGN_USER])

  await pool.query(`
    insert into organizations (id, name, slug, created_at)
    values ($1, 'Staff Foreign', 'staffcheck-foreign', now())`, [FOREIGN_ORG])
  await pool.query(`
    insert into teams (id, name, organization_id, created_at)
    values ($1, 'Cabang Salon Lain', $2, now())`, [FOREIGN_TEAM, FOREIGN_ORG])
  await pool.query(`
    insert into users (id, name, email, email_verified, created_at, updated_at)
    values ($1, 'Staf Salon Lain', 'foreign@staffcheckforeign.local', true, now(), now())`,
    [FOREIGN_USER])
  await pool.query(`
    insert into members (id, user_id, organization_id, role, created_at)
    values ('stf_foreign_m', $1, $2, 'stylist', now())`, [FOREIGN_USER, FOREIGN_ORG])
})

test.afterAll(async () => {
  // Restore from the seed export, never from the live table -- reading the
  // live value after a crashed run is what would launder a corrupted cap
  // forward to the next one.
  await pool.query(`
    update plan_limits set cap = $1
     where plan_id = (select id from plans where key = 'free') and resource = 'staff'`,
    [FREE.caps.staff])
  await pool.end()
})

test.describe.serial('provisioning: POST /api/staff (the JSON route)', () => {
  let owner: Awaited<ReturnType<typeof client>>
  let orgId: string
  let branchId: string

  test.beforeAll(async () => {
    ;({ ctx: owner, organizationId: orgId } = await createSalon(pool, {
      name: 'Stf Assign Owner', email: `assign-owner@${DOMAIN}`, password: PW,
      salon: 'Stf Check Assign', slug: 'staffcheck-assign',
    }))
    // business plan has no plan_limits row at all, so quota never interferes
    // with the assertions below regardless of whatever the default tier's
    // staff cap is seeded to right now.
    await setPlan(orgId, 'business')
    const branch = await owner.post('/api/auth/organization/create-team',
      { data: { name: 'Cabang Assign', organizationId: orgId } })
    branchId = (await branch.json()).id
  })
  test.afterAll(() => owner.dispose())

  test('provisioning a stylist with a branchId writes staff_profiles.team_id AND team_members', async () => {
    const email = `assign-stylist@${DOMAIN}`
    const made = await owner.post('/api/staff',
      { data: { name: 'Stf Assign Stylist', email, password: PW, role: 'stylist', branchId } })
    expect(made.status(), await made.text()).toBe(201)
    const stylistId = (await made.json()).user.id

    const { rows: [profile] } = await pool.query(
      `select team_id from staff_profiles where user_id = $1 and organization_id = $2`,
      [stylistId, orgId])
    expect(profile?.team_id).toBe(branchId)
    const { rows: teamMember } = await pool.query(
      `select 1 from team_members where user_id = $1 and team_id = $2`, [stylistId, branchId])
    expect(teamMember).toHaveLength(1)
  })

  // Task 4 (spec §5): the detail page's audit line, and its suppression rule.
  // provisionStaff inserts the row and assignBranch (lib/staff.ts) updates it
  // moments later with the SAME actor -- that pairing is exactly what this
  // test exercises, since it provisions a stylist WITH a branchId.
  test('the detail page names who created it, and does not show a redundant diubah line', async () => {
    const email = `assign-stylist-2@${DOMAIN}`
    const made = await owner.post('/api/staff',
      { data: { name: 'Stf Assign Stylist Two', email, password: PW, role: 'stylist', branchId } })
    expect(made.status(), await made.text()).toBe(201)
    const stylistId = (await made.json()).user.id

    const detail = await getPage(owner, `/dashboard/staff/${stylistId}`)
    expect(detail.html).toContain('Dibuat oleh Stf Assign Owner')
    expect(detail.html).not.toContain('Diubah oleh')
  })

  test('provisioning without a branchId leaves staff_profiles.team_id null', async () => {
    const email = `assign-admin@${DOMAIN}`
    const made = await owner.post('/api/staff',
      { data: { name: 'Stf Assign Admin', email, password: PW, role: 'admin' } })
    expect(made.status(), await made.text()).toBe(201)
    const adminId = (await made.json()).user.id
    const { rows: [profile] } = await pool.query(
      `select team_id from staff_profiles where user_id = $1 and organization_id = $2`,
      [adminId, orgId])
    expect(profile?.team_id).toBeNull()
  })

  // Every one of these was reproduced against the running app: the route
  // gated on `role in roles` (which contains 'owner') and had no
  // password-length check at all, and better-auth's addMember checks the
  // CALLER's membership and the teamId, never the role it writes. The
  // allow-list and the length check now live in provisionStaff, so the
  // route, both Server Actions and the import loop share one authority
  // (spec §8).
  test('role=owner is refused, and no member row -- least of all an owner -- was created for it', async () => {
    const email = `api-owner-escalation@${DOMAIN}`
    const res = await owner.post('/api/staff',
      { data: { name: 'Stf API Owner', email, password: PW, role: 'owner' } })
    expect(res.status(), await res.text()).not.toBe(201)
    // On the row, not merely on the status: a refusal that still wrote the
    // member would pass a status-only check.
    const { rows } = await pool.query(`
      select m.role from members m join users u on u.id = m.user_id
       where u.email = $1 and m.organization_id = $2`, [email, orgId])
    expect(rows).toHaveLength(0)
  })

  test('a password under the configured minimum is refused, and no login was created for it', async () => {
    const email = `api-short-password@${DOMAIN}`
    const res = await owner.post('/api/staff',
      { data: { name: 'Stf API Short', email, password: 'a', role: 'stylist', branchId } })
    expect(res.status(), await res.text()).toBe(400)
    expect((await res.json()).error).toBe('PASSWORD_TOO_SHORT')
    const { rows } = await pool.query(`select 1 from users where email = $1`, [email])
    expect(rows).toHaveLength(0)
  })

  // addMember validates teamId against the org, and it runs AFTER
  // createUser + linkAccount -- so a foreign branchId used to leave a users +
  // accounts row with no members row: invisible in /staff, still able to
  // sign in, and that email EMAIL_TAKEN forever.
  test('a foreign branchId is refused and the whole hire is unwound -- no orphaned user, account, or dead email', async () => {
    const email = `api-orphan@${DOMAIN}`
    const orphanHire = await owner.post('/api/staff',
      { data: { name: 'Stf API Orphan', email, password: PW, role: 'stylist', branchId: FOREIGN_TEAM } })
    expect(orphanHire.status(), await orphanHire.text()).not.toBe(201)
    const { rows: users } = await pool.query(`select 1 from users where email = $1`, [email])
    expect(users).toHaveLength(0)
    const { rows: accounts } = await pool.query(`
      select 1 from accounts a join users u on u.id = a.user_id where u.email = $1`, [email])
    expect(accounts).toHaveLength(0)

    // The consequence the orphan actually caused: the email is reusable.
    const reuse = await owner.post('/api/staff',
      { data: { name: 'Stf API Reuse', email, password: PW, role: 'stylist', branchId } })
    expect(reuse.status(), await reuse.text()).toBe(201)
  })
})

test.describe.serial('provisioning: the owner itself consumes a seat', () => {
  // requireQuota counts the owner too (spec: every member gets a
  // staff_profiles row, the owner included) -- proven the real way: cap the
  // default plan at 1 seat, sign in as an owner alone in their salon, and
  // try to provision a second staff member. With only the owner present, a
  // 402 proves the owner itself consumed the one seat.
  test('capping the default plan at 1 seat refuses the very first hire, with only the owner present', async () => {
    await setDefaultStaffCap(1)
    try {
      const { ctx: owner } = await createSalon(pool, {
        name: 'Stf Seat Owner', email: `seat@${DOMAIN}`, password: PW,
        salon: 'Stf Check Seat', slug: 'staffcheck-seat',
      })
      const blocked = await owner.post('/api/staff',
        { data: { name: 'Nope', email: `seat-nope@${DOMAIN}`, password: PW, role: 'stylist' } })
      expect(blocked.status(), await blocked.text()).toBe(402)
      await owner.dispose()
    } finally {
      await setDefaultStaffCap(FREE.caps.staff)
    }
  })
})

test.describe.serial('provisioning through /staff/new: pairing, escalation, cross-tenant branch', () => {
  let owner: Awaited<ReturnType<typeof client>>
  let orgId: string
  let branchId: string
  let stylistUserId: string
  let adminUserId: string

  test.beforeAll(async () => {
    ;({ ctx: owner, organizationId: orgId } = await createSalon(pool, {
      name: 'Stf List Owner', email: `list-owner@${DOMAIN}`, password: PW,
      salon: 'Stf Check List', slug: 'staffcheck-list',
    }))
    await setPlan(orgId, 'business')
    const branch = await owner.post('/api/auth/organization/create-team',
      { data: { name: 'Cabang List', organizationId: orgId } })
    branchId = (await branch.json()).id
  })
  test.afterAll(() => owner.dispose())

  test('a stylist with a branch, created through the real form, redirects to /staff with team_id set', async () => {
    const email = `list-stylist@${DOMAIN}`
    const res = await submitForm(owner, '/dashboard/staff/new', 'name="password"',
      { name: 'Stf List Stylist', email, password: PW, role: 'stylist', teamId: branchId })
    expect(res.status, res.html).toBe(303)
    expect(res.location ?? '').toContain('/dashboard/staff')
    const { rows: [profile] } = await pool.query(`
      select s.user_id, s.team_id from staff_profiles s join users u on u.id = s.user_id
       where u.email = $1 and s.organization_id = $2`, [email, orgId])
    expect(profile?.team_id).toBe(branchId)
    stylistUserId = profile.user_id
  })

  test('an admin with no branch, created through the real form, redirects to /staff with team_id null', async () => {
    const email = `list-admin@${DOMAIN}`
    const res = await submitForm(owner, '/dashboard/staff/new', 'name="password"',
      { name: 'Stf List Admin', email, password: PW, role: 'admin' })
    expect(res.status, res.html).toBe(303)
    const { rows: [profile] } = await pool.query(`
      select s.user_id, s.team_id from staff_profiles s join users u on u.id = s.user_id
       where u.email = $1 and s.organization_id = $2`, [email, orgId])
    expect(profile?.team_id).toBeNull()
    adminUserId = profile.user_id
  })

  test('a stylist with no branch is refused, not redirected, and creates no user', async () => {
    const email = `list-bad-stylist@${DOMAIN}`
    const res = await submitForm(owner, '/dashboard/staff/new', 'name="password"',
      { name: 'Stf Bad Stylist', email, password: PW, role: 'stylist' })
    expect(res.status).toBe(200)
    expect(res.html).toContain('Pilih cabang untuk peran ini.')
    const { rows } = await pool.query(`select 1 from users where email = $1`, [email])
    expect(rows).toHaveLength(0)
  })

  test('an admin with a branch is refused, not redirected, and creates no user', async () => {
    const email = `list-bad-admin@${DOMAIN}`
    const res = await submitForm(owner, '/dashboard/staff/new', 'name="password"',
      { name: 'Stf Bad Admin', email, password: PW, role: 'admin', teamId: branchId })
    expect(res.status).toBe(200)
    expect(res.html).toContain('Peran ini tidak ditempatkan di cabang.')
    const { rows } = await pool.query(`select 1 from users where email = $1`, [email])
    expect(rows).toHaveLength(0)
  })

  test('a teamId from another salon is refused with Indonesian copy, not the English addMember message', async () => {
    const email = `list-bad-team@${DOMAIN}`
    const res = await submitForm(owner, '/dashboard/staff/new', 'name="password"',
      { name: 'Stf Bad Team', email, password: PW, role: 'stylist', teamId: FOREIGN_TEAM })
    expect(res.status).toBe(200)
    expect(res.html).toContain(BRANCH_NOT_FOUND_MSG)
    expect(res.html).not.toContain('Team not found')
    const { rows } = await pool.query(`select 1 from users where email = $1`, [email])
    expect(rows).toHaveLength(0)
  })

  // The escalation this fix closes: role=owner with no branch used to pass
  // both pairing checks (NEEDS_BRANCH excludes 'owner') and provisionStaff's
  // own `role in roles` gate (which also included 'owner'). staff:['create']
  // is held by admin as well as owner, so this was a path from admin to
  // owner. Asserted on the actual members row count, not merely "an error
  // came back".
  test('posting role=owner through the form is refused, not redirected, and creates no member row', async () => {
    const email = `list-escalate@${DOMAIN}`
    const res = await submitForm(owner, '/dashboard/staff/new', 'name="password"',
      { name: 'Stf Escalate', email, password: PW, role: 'owner' })
    expect(res.status).toBe(200)
    expect(res.html).toContain('Peran tidak valid.')
    const { rows } = await pool.query(`
      select 1 from members m join users u on u.id = m.user_id
       where u.email = $1 and m.organization_id = $2`, [email, orgId])
    expect(rows).toHaveLength(0)
  })

  test('front desk and stylist are both redirected away from /staff', async () => {
    const deskEmail = `list-desk@${DOMAIN}`
    const madeDesk = await owner.post('/api/staff',
      { data: { name: 'Stf List Desk', email: deskEmail, password: PW, role: 'frontdesk', branchId } })
    expect(madeDesk.status(), await madeDesk.text()).toBe(201)

    const desk = await client()
    await desk.post('/api/auth/sign-in/email', { data: { email: deskEmail, password: PW } })
    const deskRes = await desk.get('/dashboard/staff')
    expect(deskRes.status(), `got ${deskRes.status()}`).toBe(307)
    expect(deskRes.headers()['location'] ?? '').toContain('/dashboard')
    await desk.dispose()

    const stylist = await client()
    await stylist.post('/api/auth/sign-in/email', { data: { email: `list-stylist@${DOMAIN}`, password: PW } })
    const stylistRes = await stylist.get('/dashboard/staff')
    expect(stylistRes.status(), `got ${stylistRes.status()}`).toBe(307)
    expect(stylistRes.headers()['location'] ?? '').toContain('/dashboard')
    await stylist.dispose()
  })

  test("another salon's staff id is not a 200 with data, and their name never leaks", async () => {
    const { rows: crossScope } = await pool.query(`
      select 1 from staff_profiles where user_id = $1 and organization_id = $2`,
      [FOREIGN_USER, orgId])
    expect(crossScope).toHaveLength(0)

    const cross = await getPage(owner, `/dashboard/staff/${FOREIGN_USER}`)
    expect(cross.status).not.toBe(200)
    expect(cross.html).not.toContain('Staf Salon Lain')
  })

  test.describe('§8: role change and branch transfer, using the stylist and admin created above', () => {
    test('promoting a stylist to admin succeeds, and clears the branch (spec §7.7)', async () => {
      const promoted = await submitForm(owner, `/dashboard/staff/${stylistUserId}`,
        'Simpan peran</button>', { userId: stylistUserId, role: 'admin' })
      expect(promoted.status, promoted.html).toBe(200)
      const { rows: [after] } = await pool.query(`
        select m.role, s.team_id from members m
          join staff_profiles s on s.user_id = m.user_id and s.organization_id = m.organization_id
         where m.user_id = $1 and m.organization_id = $2`, [stylistUserId, orgId])
      expect(after?.role).toBe('admin')
      expect(after?.team_id).toBeNull()
    })

    test('demoting an admin to stylist without a branch is refused, and the role is left unchanged', async () => {
      const demoted = await submitForm(owner, `/dashboard/staff/${adminUserId}`,
        'Simpan peran</button>', { userId: adminUserId, role: 'stylist' })
      expect(demoted.status).toBe(200)
      expect(demoted.html).toContain('Pilih cabang untuk peran ini.')
      const { rows: [stillAdmin] } = await pool.query(
        `select role from members where user_id = $1 and organization_id = $2`, [adminUserId, orgId])
      expect(stillAdmin?.role).toBe('admin')
    })

    test('an admin cannot change the owner\'s role, and the owner keeps their role', async () => {
      const adminClient = await client()
      await adminClient.post('/api/auth/sign-in/email',
        { data: { email: `list-admin@${DOMAIN}`, password: PW } })
      const { rows: [ownerRow] } = await pool.query(
        `select user_id from members where organization_id = $1 and role = 'owner'`, [orgId])
      const res = await submitForm(adminClient, `/dashboard/staff/${ownerRow.user_id}`,
        'Simpan peran</button>', { userId: ownerRow.user_id, role: 'stylist', teamId: branchId })
      expect(res.status).toBe(200)
      expect(res.html).toContain('Hanya pemilik yang dapat mengubah peran pemilik.')
      const { rows: [stillOwner] } = await pool.query(
        `select role from members where user_id = $1 and organization_id = $2`,
        [ownerRow.user_id, orgId])
      expect(stillOwner?.role).toBe('owner')
      await adminClient.dispose()
    })
  })
})

/**
 * Phase-2 review, finding 2: `memberIdFor` (app/dashboard/(shell)/staff/actions.ts)
 * picked whichever of a person's `members` rows Postgres happened to return
 * first for `... limit 1` with no `order by` -- a query with no natural
 * ordering. A person can hold two rows in the same salon the same way the
 * dual-role fixture in tests/staff.db.test.ts reaches it: invite an address,
 * create the same person through "Tambah staf", then accept the stale
 * invitation. Demoting that person used to touch only the ROW `memberIdFor`
 * happened to pick -- if that was their weaker row, the actual 'owner' row
 * was left completely untouched, and the person stayed an owner despite the
 * screen (and every other read of them) reporting the demotion succeeded.
 *
 * Reproduced deterministically here by controlling INSERT order: `members`
 * has a btree index on user_id and no other ordering guarantee, and a bitmap
 * heap scan over that index returns matching rows in heap (insertion) order
 * for a freshly-inserted, never-updated table -- confirmed directly against
 * this Postgres before writing this fixture. Inserting the weaker ('admin')
 * row FIRST and the 'owner' row SECOND means the old `limit 1` with no
 * `order by` reliably picked the admin row, leaving the owner row alone.
 */
test.describe.serial('a person with two membership rows: demoting them must not leave a stale owner row behind', () => {
  let owner: Awaited<ReturnType<typeof client>>
  let orgId: string
  let branchId: string
  let dualUserId: string
  let ownerRowId: string
  let adminRowId: string

  test.beforeAll(async () => {
    ;({ ctx: owner, organizationId: orgId } = await createSalon(pool, {
      name: 'Stf Dual Owner', email: `dual-owner@${DOMAIN}`, password: PW,
      salon: 'Stf Check Dual', slug: 'staffcheck-dual',
    }))
    await setPlan(orgId, 'business')
    const branch = await owner.post('/api/auth/organization/create-team',
      { data: { name: 'Cabang Dual', organizationId: orgId } })
    branchId = (await branch.json()).id

    // A login with no members row of its own yet -- both rows below are
    // inserted directly, the same way the dual-role fixture in
    // tests/staff.db.test.ts does it, since this state (two rows for one
    // person in one salon) is reachable but not something any single form
    // submission produces.
    const email = `dual-member@${DOMAIN}`
    const created = await pool.query(`
      insert into users (id, name, email, email_verified, created_at, updated_at)
      values (gen_random_uuid()::text, 'Stf Dual Member', $1, true, now(), now())
      returning id`, [email])
    dualUserId = created.rows[0].id

    adminRowId = `${dualUserId}_m_admin`
    ownerRowId = `${dualUserId}_m_owner`
    // Admin row first, owner row second -- see the fixture-order note above.
    await pool.query(`
      insert into members (id, user_id, organization_id, role, created_at)
      values ($1, $2, $3, 'admin', now())`, [adminRowId, dualUserId, orgId])
    await pool.query(`
      insert into members (id, user_id, organization_id, role, created_at)
      values ($1, $2, $3, 'owner', now())`, [ownerRowId, dualUserId, orgId])
  })
  test.afterAll(() => owner.dispose())

  test('the row that said owner is the one that changed, not the weaker row a nondeterministic pick might have touched instead', async () => {
    const demoted = await submitForm(owner, `/dashboard/staff/${dualUserId}`,
      'Simpan peran</button>', { userId: dualUserId, role: 'stylist', teamId: branchId })
    expect(demoted.status, demoted.html).toBe(200)
    expect(demoted.html).toContain('Peran diperbarui.')

    const { rows: [afterOwnerRow] } = await pool.query(
      `select role from members where id = $1`, [ownerRowId])
    expect(afterOwnerRow?.role, 'the row that used to say owner').toBe('stylist')

    const { rows: [afterAdminRow] } = await pool.query(
      `select role from members where id = $1`, [adminRowId])
    expect(afterAdminRow?.role, 'the other row, so the person is not left with two conflicting roles').toBe('stylist')
  })
})

/**
 * Fix 2 (crud-phase-3 review): `isOwner` (app/dashboard/(shell)/staff/actions.ts)
 * did `select role from members ... limit 1` with no `order by` -- the exact
 * shape `memberIdsFor` above was already fixed to stop using, left behind in
 * its sibling. It gates every owner-protection check (role change,
 * deactivation, password reset), so a genuine owner holding two rows was
 * refused acting on a fellow owner whenever the arbitrary pick landed on
 * their WEAKER row.
 *
 * Deactivation, not the role-change form: updateStaffRoleAction's write goes
 * through better-auth's own updateMemberRole, which resolves the ACTING
 * member through its own (separately ambiguous, see the self-demotion block
 * below) lookup -- confounding a role-change test with a second, unrelated
 * race. deactivateStaffAction never calls into better-auth at all; the only
 * thing standing between a dual-membership owner and deactivating a co-owner
 * is this app's own `isOwner` gate, which is what this test isolates.
 *
 * Reproduced with the same fixture shape as the describe block above --
 * 'admin' inserted first, 'owner' second, which this Postgres reliably
 * returns in insertion order for `limit 1` with no `order by` (see that
 * block's own comment) -- except this time the dual-membership person is the
 * ACTOR, deactivating a genuine second owner. `staffOf` (lib/staff.ts)
 * already reads this person's roles as the union via `string_agg`, so before
 * this fix the actor-side check disagreed with how the target side is read.
 */
test.describe.serial('a dual-membership owner acting on a fellow owner must not be refused for it', () => {
  let owner: Awaited<ReturnType<typeof client>>
  let orgId: string
  let dualCtx: Awaited<ReturnType<typeof client>>
  let dualUserId: string
  let coOwnerUserId: string

  test.beforeAll(async () => {
    ;({ ctx: owner, organizationId: orgId } = await createSalon(pool, {
      name: 'Stf Dual Actor Owner', email: `dual-actor-owner@${DOMAIN}`, password: PW,
      salon: 'Stf Check Dual Actor', slug: 'staffcheck-dualactor',
    }))
    await setPlan(orgId, 'business')

    // A genuine second owner -- no login needed, this person never signs in
    // here, only their `members.role` is read by the actor-side check.
    const coOwner = await pool.query(`
      insert into users (id, name, email, email_verified, created_at, updated_at)
      values (gen_random_uuid()::text, 'Stf Dual Co Owner', $1, true, now(), now())
      returning id`, [`dual-co-owner@${DOMAIN}`])
    coOwnerUserId = coOwner.rows[0].id
    await pool.query(`
      insert into members (id, user_id, organization_id, role, created_at)
      values (gen_random_uuid()::text, $1, $2, 'owner', now())`, [coOwnerUserId, orgId])

    // The dual-membership actor: a real login, with an 'admin' row inserted
    // BEFORE the 'owner' row -- the exact insertion order the fixture above
    // documents as the one `limit 1` with no `order by` reliably mis-picks.
    const email = `dual-actor@${DOMAIN}`
    dualUserId = await createLogin(pool, { name: 'Stf Dual Actor', email, password: PW })
    await pool.query(`
      insert into members (id, user_id, organization_id, role, created_at)
      values ($1, $2, $3, 'admin', now())`, [`${dualUserId}_m_admin`, dualUserId, orgId])
    await pool.query(`
      insert into members (id, user_id, organization_id, role, created_at)
      values ($1, $2, $3, 'owner', now())`, [`${dualUserId}_m_owner`, dualUserId, orgId])

    dualCtx = await signIn(email, PW)
    await dualCtx.post('/api/auth/organization/set-active', { data: { organizationId: orgId } })
  })
  test.afterAll(async () => {
    await owner.dispose()
    await dualCtx.dispose()
  })

  test('the dual-membership owner can deactivate a fellow owner, not refused with "Hanya pemilik"', async () => {
    const res = await submitForm(dualCtx, `/dashboard/staff/${coOwnerUserId}`,
      'Nonaktifkan staf</button>', { userId: coOwnerUserId })
    expect(res.status, res.html).toBe(200)
    expect(res.html).not.toContain('Hanya pemilik yang dapat menonaktifkan pemilik.')

    const { rows: [after] } = await pool.query(
      `select active from staff_profiles where user_id = $1 and organization_id = $2`,
      [coOwnerUserId, orgId])
    expect(after?.active, 'the co-owner was actually deactivated, not merely unrefused').toBe(false)
  })
})

/**
 * Fix-round finding: the multi-row loop above (memberIdsFor's docstring)
 * cannot be one transaction, so a failure partway through can leave some of
 * a person's rows on the new role and some not -- while the old code
 * reported that as a flat "Gagal mengubah peran.", exactly as if nothing had
 * happened. This reproduces a REAL partial failure (no mocking, no stubbed
 * throw) using better-auth's own rules, not a contrived one:
 *
 * A person holding TWO 'owner' rows in the same salon (equally reachable as
 * the admin+owner pair above -- `members` enforces nothing about which roles
 * two rows may combine) demotes THEMSELVES, with every OTHER real owner in
 * the salon already gone. The app's own activeOwnerCount is a plain `join`
 * with no dedup (app/dashboard/(shell)/staff/actions.ts) -- it counts this
 * one person's two rows as two owners, so the last-owner guard never fires
 * even though they are, in truth, the only one. memberIdsFor's loop then
 * updates their first row successfully -- and the second call is refused by
 * better-auth ITSELF (crud-members.mjs's own updateMemberRole), for one of
 * two reasons depending only on which of the person's own rows better-auth's
 * findMemberByOrgId happens to resolve as "the acting member" this time:
 * either that lookup now returns the already-demoted row (role no longer
 * 'owner'), so the actor is no longer seen as able to touch an owner row at
 * all (FORBIDDEN); or it returns the row still being demoted, and
 * better-auth's own "cannot leave the organization without an owner" check
 * fires because, mid-loop, this row is genuinely the only 'owner' row left
 * in the whole organization (BAD_REQUEST). Both outcomes throw -- there is
 * no path where the second call quietly succeeds -- so this is deterministic
 * without depending on which one better-auth picks.
 */
test.describe.serial('a self-demotion that fails partway must not be reported as if nothing happened', () => {
  let owner: Awaited<ReturnType<typeof client>>
  let orgId: string
  let creatorUserId: string
  let dualUserId: string
  let rowA: string
  let rowB: string
  let dualCtx: Awaited<ReturnType<typeof client>>

  test.beforeAll(async () => {
    ;({ ctx: owner, organizationId: orgId, userId: creatorUserId } = await createSalon(pool, {
      name: 'Stf Partial Owner', email: `partial-owner@${DOMAIN}`, password: PW,
      salon: 'Stf Check Partial', slug: 'staffcheck-partial',
    }))
    await setPlan(orgId, 'business')

    // A real login, so this person can sign in and demote THEMSELVES.
    const email = `partial-dual@${DOMAIN}`
    dualUserId = await createLogin(pool, { name: 'Stf Partial Dual', email, password: PW })

    // Two rows, BOTH 'owner' -- ids chosen so `rowA` sorts first, matching
    // memberIdsFor's `order by id`, so which row is processed first (and
    // succeeds) is pinned down for the assertions below.
    rowA = `${dualUserId}_a_owner`
    rowB = `${dualUserId}_b_owner`
    await pool.query(`
      insert into members (id, user_id, organization_id, role, created_at)
      values ($1, $2, $3, 'owner', now()), ($4, $2, $3, 'owner', now())`,
      [rowA, dualUserId, orgId, rowB])

    // The salon's creator is no longer an owner at all -- this person's two
    // rows are the ONLY thing saying this salon has an owner. Bypasses the
    // app (a real admin/owner demoting the last owner is refused, spec 6.1)
    // because reaching this state through the app is not what this test is
    // about; the state itself is what matters; it does not violate the
    // ownerless-salon trigger (migration 0025) because the dual person's two
    // rows still say owner when this statement commits.
    await pool.query(`update members set role = 'stylist' where user_id = $1 and organization_id = $2`,
      [creatorUserId, orgId])

    dualCtx = await signIn(email, PW)
    await dualCtx.post('/api/auth/organization/set-active', { data: { organizationId: orgId } })
  })
  test.afterAll(async () => {
    await owner.dispose()
    await dualCtx.dispose()
  })

  test('one row changes, the other is refused by better-auth itself, and the response says so -- not "Gagal mengubah peran." as if nothing happened', async () => {
    const res = await submitForm(dualCtx, `/dashboard/staff/${dualUserId}`,
      'Simpan peran</button>', { userId: dualUserId, role: 'admin' })
    expect(res.status, res.html).toBe(200)

    const { rows: [afterA] } = await pool.query(`select role from members where id = $1`, [rowA])
    const { rows: [afterB] } = await pool.query(`select role from members where id = $1`, [rowB])
    expect(afterA?.role, 'the first row (memberIdsFor\'s order) converged').toBe('admin')
    expect(afterB?.role, 'the second row was refused by better-auth and stayed put').toBe('owner')

    // The dishonest report this fix exists to prevent: a flat failure
    // message would read as "nothing happened", which is false -- rowA
    // already changed. A flat success would be equally false -- rowB did not.
    expect(res.html).not.toContain('Peran diperbarui.')
    expect(res.html, 'names that it was partial, not a bare "Gagal mengubah peran."')
      .toContain('Peran berhasil diubah untuk 1 dari 2')
  })
})

test.describe.serial('branch-status guard applied to staff assignment (creation, transfer, role change, reactivation)', () => {
  // Fresh owner on 'pro' (branches cap 3, fixed by seed-plans.mjs -- nothing
  // here needs restoring afterward, unlike the default-plan staff cap
  // elsewhere in this file). Extra branches are raw INSERTs into teams, not
  // '/organization/create-team' -- that endpoint's own quota check would
  // refuse anything past the cap (tests/branch.db.test.ts), which is exactly
  // the over-cap state this fixture needs to reach.
  let owner: Awaited<ReturnType<typeof client>>
  let orgId: string
  let withinBranchId: string
  let overCapBranchId: string
  let closedBranchId: string
  let bothBranchId: string
  let openBranchId: string
  let guardStylistId: string
  let guardAdminId: string

  const teamIdOf = async (userId: string) => (await pool.query(
    `select team_id from staff_profiles where user_id = $1 and organization_id = $2`,
    [userId, orgId])).rows[0]?.team_id as string | null
  const roleOf = async (userId: string) => (await pool.query(
    `select role from members where user_id = $1 and organization_id = $2`,
    [userId, orgId])).rows[0]?.role as string | undefined

  test.beforeAll(async () => {
    ;({ ctx: owner, organizationId: orgId } = await createSalon(pool, {
      name: 'Stf Guard Owner', email: `guard-owner@${DOMAIN}`, password: PW,
      salon: 'Stf Check Guard', slug: 'staffcheck-guard',
    }))
    await setPlan(orgId, 'pro')

    const mkBranch = (id: string, name: string, offsetSec: number) => pool.query(`
      insert into teams (id, name, organization_id, created_at)
      values ($1, $2, $3, now() + ($4 || ' seconds')::interval)`, [id, name, orgId, offsetSec])
    await mkBranch('stf_guard_fill2', 'Cabang Guard 2', 1)
    await mkBranch('stf_guard_fill3', 'Cabang Guard 3', 2)
    await mkBranch('stf_guard_overcap', 'Cabang Guard Overcap', 3)
    await mkBranch('stf_guard_closed', 'Cabang Guard Closed', 4)
    await mkBranch('stf_guard_both', 'Cabang Guard Both', 5)
    openBranchId = 'stf_guard_fill2'
    overCapBranchId = 'stf_guard_overcap'
    closedBranchId = 'stf_guard_closed'
    bothBranchId = 'stf_guard_both'
    withinBranchId = await defaultTeamOf(orgId)

    // Preconditions asserted, not assumed (tests/README.md's own trap): both
    // fixture branches genuinely rank over cap BEFORE they are also closed.
    // Queried directly against branch_entitlement/branch_profiles rather
    // than through getBranchStatus() -- that function's own precedence
    // (closed beats over_cap) is already proven in tests/branch.db.test.ts,
    // and importing app lib code straight into an e2e spec would read
    // process.env.DATABASE_URL from the TEST RUNNER's own process, not the
    // webServer's (see playwright.config.ts's `env`), pointing it at the
    // wrong database entirely.
    const withinCapOf = async (teamId: string) => (await pool.query(
      `select within_cap from branch_entitlement where team_id = $1`, [teamId])).rows[0]?.within_cap ?? false
    expect(await withinCapOf(overCapBranchId)).toBe(false)
    expect(await withinCapOf(closedBranchId)).toBe(false)
    expect(await withinCapOf(bothBranchId)).toBe(false)
    await pool.query(`update branch_profiles set active = false where team_id = any($1)`,
      [[closedBranchId, bothBranchId]])
    const { rows: [closedRow] } = await pool.query(
      `select active from branch_profiles where team_id = $1`, [closedBranchId])
    expect(closedRow.active).toBe(false)

    const madeStylist = await owner.post('/api/staff', {
      data: { name: 'Stf Guard Stylist', email: `guard-stylist@${DOMAIN}`, password: PW,
        role: 'stylist', branchId: withinBranchId },
    })
    expect(madeStylist.status(), await madeStylist.text()).toBe(201)
    guardStylistId = (await madeStylist.json()).user.id

    const madeAdmin = await owner.post('/api/staff', {
      data: { name: 'Stf Guard Admin', email: `guard-admin@${DOMAIN}`, password: PW, role: 'admin' },
    })
    expect(madeAdmin.status(), await madeAdmin.text()).toBe(201)
    guardAdminId = (await madeAdmin.json()).user.id
  })
  test.afterAll(() => owner.dispose())

  test('creating into an over-cap branch is refused with the over-cap copy, and creates no user', async () => {
    const email = `guard-create-overcap@${DOMAIN}`
    const res = await submitForm(owner, '/dashboard/staff/new', 'name="password"',
      { name: 'Stf Guard Create Overcap', email, password: PW, role: 'stylist', teamId: overCapBranchId })
    expect(res.status).toBe(200)
    expect(res.html).toContain(OVERCAP_MSG)
    const { rows } = await pool.query(`select 1 from users where email = $1`, [email])
    expect(rows).toHaveLength(0)
  })

  test('creating into a closed branch is refused with the closed copy, and creates no user', async () => {
    const email = `guard-create-closed@${DOMAIN}`
    const res = await submitForm(owner, '/dashboard/staff/new', 'name="password"',
      { name: 'Stf Guard Create Closed', email, password: PW, role: 'stylist', teamId: closedBranchId })
    expect(res.status).toBe(200)
    expect(res.html).toContain(CLOSED_MSG)
    const { rows } = await pool.query(`select 1 from users where email = $1`, [email])
    expect(rows).toHaveLength(0)
  })

  test('creating into another salon\'s CLOSED branch reads as not-found, never as closed -- no existence leak', async () => {
    // getBranchStatus used to take no organizationId, so it answered for ANY
    // salon's branch -- naming another salon's closed branch returned the
    // closed copy, which confirms the branch exists (spec §6.3). FOREIGN_TEAM
    // is closed here to make the leak reachable at all -- without this, a
    // not-found result would be trivially true (it isn't closed, so there is
    // nothing to leak) and would pass even if the leak still existed.
    await pool.query(`update branch_profiles set active = false where team_id = $1`, [FOREIGN_TEAM])
    try {
      const email = `guard-create-foreign@${DOMAIN}`
      const res = await submitForm(owner, '/dashboard/staff/new', 'name="password"',
        { name: 'Stf Guard Create Foreign', email, password: PW, role: 'stylist', teamId: FOREIGN_TEAM })
      expect(res.status).toBe(200)
      expect(res.html).toContain(BRANCH_NOT_FOUND_MSG)
      expect(res.html).not.toContain(CLOSED_MSG)
      const { rows } = await pool.query(`select 1 from users where email = $1`, [email])
      expect(rows).toHaveLength(0)
    } finally {
      await pool.query(`update branch_profiles set active = true where team_id = $1`, [FOREIGN_TEAM])
    }
  })

  test('transfer to a closed branch, then to a locked branch, both refused and unchanged (spec §7.10)', async () => {
    const xferClosed = await submitForm(owner, `/dashboard/staff/${guardStylistId}`,
      'Pindahkan</button>', { userId: guardStylistId, teamId: closedBranchId })
    expect(xferClosed.status).toBe(200)
    expect(xferClosed.html).toContain(CLOSED_MSG)
    expect(await teamIdOf(guardStylistId)).toBe(withinBranchId)

    const xferOverCap = await submitForm(owner, `/dashboard/staff/${guardStylistId}`,
      'Pindahkan</button>', { userId: guardStylistId, teamId: overCapBranchId })
    expect(xferOverCap.status).toBe(200)
    expect(xferOverCap.html).toContain(OVERCAP_MSG)
    expect(await teamIdOf(guardStylistId)).toBe(withinBranchId)
  })

  test('a branch that is both closed and locked yields the closed message, not the over-cap one (spec §7.10)', async () => {
    const xferBoth = await submitForm(owner, `/dashboard/staff/${guardStylistId}`,
      'Pindahkan</button>', { userId: guardStylistId, teamId: bothBranchId })
    expect(xferBoth.status).toBe(200)
    expect(xferBoth.html).toContain(CLOSED_MSG)
    expect(xferBoth.html).not.toContain(OVERCAP_MSG)
    expect(await teamIdOf(guardStylistId)).toBe(withinBranchId)
  })

  test('a transfer to another salon\'s CLOSED team reads as not-found (no leak), and writes no team_members row for it', async () => {
    const { rows: before } = await pool.query(
      `select 1 from team_members where team_id = $1 and user_id = $2`, [FOREIGN_TEAM, guardStylistId])
    expect(before).toHaveLength(0)

    // Closed here too, for the same reason as the creation-path check above:
    // a not-found result against an OPEN foreign branch would be trivially
    // true and would not prove the leak is actually prevented.
    await pool.query(`update branch_profiles set active = false where team_id = $1`, [FOREIGN_TEAM])
    let xferCross: Awaited<ReturnType<typeof submitForm>>
    try {
      xferCross = await submitForm(owner, `/dashboard/staff/${guardStylistId}`,
        'Pindahkan</button>', { userId: guardStylistId, teamId: FOREIGN_TEAM })
    } finally {
      await pool.query(`update branch_profiles set active = true where team_id = $1`, [FOREIGN_TEAM])
    }
    expect(xferCross.status).toBe(200)
    expect(xferCross.html).toContain(BRANCH_NOT_FOUND_MSG)
    expect(xferCross.html).not.toContain(CLOSED_MSG)
    expect(xferCross.html).not.toContain(OVERCAP_MSG)
    expect(await teamIdOf(guardStylistId)).toBe(withinBranchId)

    const { rows: after } = await pool.query(
      `select 1 from team_members where team_id = $1 and user_id = $2`, [FOREIGN_TEAM, guardStylistId])
    expect(after).toHaveLength(0)
  })

  test('the happy path: transfer to an open branch moves BOTH the assignment and the navigational row, and a fresh sign-in lands at the new branch', async () => {
    const xferOk = await submitForm(owner, `/dashboard/staff/${guardStylistId}`,
      'Pindahkan</button>', { userId: guardStylistId, teamId: openBranchId })
    expect(xferOk.status, xferOk.html).toBe(200)
    expect(await teamIdOf(guardStylistId)).toBe(openBranchId)

    const { rows: moved } = await pool.query(
      `select 1 from team_members where team_id = $1 and user_id = $2`, [openBranchId, guardStylistId])
    expect(moved).toHaveLength(1)
    // The other half transfer never used to do: the OLD row has to go, or a
    // fresh sign-in resolves activeTeamId from the OLDEST team_members row
    // and lands the staff member back where they were moved out of --
    // unable to correct it themselves (frontdesk/stylist hold branch:['read']
    // with no switch).
    const { rows: stale } = await pool.query(
      `select 1 from team_members where team_id = $1 and user_id = $2`, [withinBranchId, guardStylistId])
    expect(stale).toHaveLength(0)
    const { rows: allRows } = await pool.query(`
      select tm.team_id from team_members tm join teams t on t.id = tm.team_id
       where tm.user_id = $1 and t.organization_id = $2`, [guardStylistId, orgId])
    expect(allRows).toHaveLength(1)
    expect(allRows[0].team_id).toBe(openBranchId)

    const movedClient = await client()
    await movedClient.post('/api/auth/sign-in/email',
      { data: { email: `guard-stylist@${DOMAIN}`, password: PW } })
    const session = await movedClient.get('/api/auth/get-session')
    expect((await session.json())?.session?.activeTeamId).toBe(openBranchId)
    await movedClient.dispose()
  })

  test('an owner may be placed at a branch -- the working-owner case -- but the branch guard still applies', async () => {
    // This used to assert the opposite: owner and admin were salon-wide and
    // refused a branch outright. That made a working owner unbookable --
    // available_slots requires staff_profiles.team_id -- and in a small salon
    // the owner cutting hair is the normal case (PRD §5.1). team_id now
    // answers "works here"; only is_stationed() decides who a branch closure
    // would strand.
    const { rows: [ownerRow] } = await pool.query(
      `select user_id from members where organization_id = $1 and role = 'owner'`, [orgId])

    // The relaxation does NOT relax the branch-status guard, which is what
    // this describe block is about.
    const closed = await submitForm(owner, `/dashboard/staff/${guardStylistId}`,
      'Pindahkan</button>', { userId: ownerRow.user_id, teamId: closedBranchId })
    expect(closed.status).toBe(200)
    expect(closed.html).toContain(CLOSED_MSG)
    expect(await teamIdOf(ownerRow.user_id)).toBeNull()

    const placed = await submitForm(owner, `/dashboard/staff/${guardStylistId}`,
      'Pindahkan</button>', { userId: ownerRow.user_id, teamId: openBranchId })
    expect(placed.status).toBe(200)
    expect(await teamIdOf(ownerRow.user_id)).toBe(openBranchId)

    const ownerPage = await getPage(owner, `/dashboard/staff/${ownerRow.user_id}`)
    expect(ownerPage.html).toContain('Pindahkan</button>')
    // ...and the opt-out, which only the roles that do not require a branch get.
    expect(ownerPage.html).toContain('Lepaskan dari cabang</button>')

    const released = await submitForm(owner, `/dashboard/staff/${ownerRow.user_id}`,
      'Lepaskan dari cabang</button>', { userId: ownerRow.user_id, release: '1' })
    expect(released.status).toBe(200)
    expect(await teamIdOf(ownerRow.user_id)).toBeNull()
  })

  test('a role change onto a closed branch, then a locked branch, both refused and unchanged', async () => {
    const roleClosed = await submitForm(owner, `/dashboard/staff/${guardStylistId}`,
      'Simpan peran</button>', { userId: guardStylistId, role: 'stylist', teamId: closedBranchId })
    expect(roleClosed.status).toBe(200)
    expect(roleClosed.html).toContain(CLOSED_MSG)
    expect(await teamIdOf(guardStylistId)).toBe(openBranchId)

    const roleOverCap = await submitForm(owner, `/dashboard/staff/${guardStylistId}`,
      'Simpan peran</button>', { userId: guardStylistId, role: 'stylist', teamId: overCapBranchId })
    expect(roleOverCap.status).toBe(200)
    expect(roleOverCap.html).toContain(OVERCAP_MSG)
    expect(await teamIdOf(guardStylistId)).toBe(openBranchId)
  })

  test('a demotion naming another salon\'s branch is refused, not reported as success, and BOTH halves stay untouched', async () => {
    // The bug this guards: assignBranch's return value dropped meant a
    // demotion naming a branch that is not this salon's wrote members.role
    // and left team_id untouched -- a stylist with NO branch at all (the §4
    // invariant this action exists to enforce), reported as "Peran
    // diperbarui."
    const res = await submitForm(owner, `/dashboard/staff/${guardAdminId}`,
      'Simpan peran</button>', { userId: guardAdminId, role: 'stylist', teamId: FOREIGN_TEAM })
    expect(res.status).toBe(200)
    expect(res.html).toContain(BRANCH_NOT_FOUND_MSG)
    expect(res.html).not.toContain('Peran diperbarui.')
    expect(await roleOf(guardAdminId)).toBe('admin')
    expect(await teamIdOf(guardAdminId)).toBeNull()
  })

  test('the happy path: a real demotion onto a real branch writes BOTH halves', async () => {
    const res = await submitForm(owner, `/dashboard/staff/${guardAdminId}`,
      'Simpan peran</button>', { userId: guardAdminId, role: 'stylist', teamId: 'stf_guard_fill3' })
    expect(res.status).toBe(200)
    expect(res.html).toContain('Peran diperbarui.')
    expect(await roleOf(guardAdminId)).toBe('stylist')
    expect(await teamIdOf(guardAdminId)).toBe('stf_guard_fill3')
  })

  test('reactivation walks a seat back into whatever branch closed while they were gone, and requireQuota is not the only check', async () => {
    // Closing a branch once its last active member has left is correct
    // (assignedStaff counts only active profiles, spec §5), so
    // deactivate -> close -> reactivate is the ordinary sequence, not an
    // edge case.
    await submitForm(owner, `/dashboard/staff/${guardStylistId}`,
      'Nonaktifkan staf</button>', { userId: guardStylistId })
    const { rows: [afterDeactivate] } = await pool.query(
      `select active from staff_profiles where user_id = $1 and organization_id = $2`,
      [guardStylistId, orgId])
    expect(afterDeactivate.active).toBe(false)
    await pool.query(`update branch_profiles set active = false where team_id = $1`, [openBranchId])

    const rehireClosed = await submitForm(owner, `/dashboard/staff/${guardStylistId}`,
      'Aktifkan staf</button>', { userId: guardStylistId })
    expect(rehireClosed.status).toBe(200)
    expect(rehireClosed.html).toContain(CLOSED_MSG)
    const { rows: [stillInactive] } = await pool.query(
      `select active from staff_profiles where user_id = $1 and organization_id = $2`,
      [guardStylistId, orgId])
    expect(stillInactive.active).toBe(false)

    await pool.query(`update branch_profiles set active = true where team_id = $1`, [openBranchId])
    const rehireOpen = await submitForm(owner, `/dashboard/staff/${guardStylistId}`,
      'Aktifkan staf</button>', { userId: guardStylistId })
    expect(rehireOpen.status).toBe(200)
    const { rows: [nowActive] } = await pool.query(
      `select active from staff_profiles where user_id = $1 and organization_id = $2`,
      [guardStylistId, orgId])
    expect(nowActive.active).toBe(true)
  })
})

test.describe.serial('assignment does not depend on role strings (through the real branch deactivation screen)', () => {
  // The bug this replaces: a custom management role like 'manajer' is not in
  // array['owner', 'admin'], so an old team_members + role-deny-list
  // predicate counted its holder as staff and made the branch permanently
  // undeactivatable, naming them as the blocker with no screen to remove
  // them. tests/staff.db.test.ts already proves the trigger seeds team_id
  // null for this fixture at the DB level -- this proves the CONSEQUENCE:
  // the branch deactivation screen reads staff_profiles, not role strings.
  let owner: Awaited<ReturnType<typeof client>>
  let orgId: string
  let branchId: string

  test.beforeAll(async () => {
    ;({ ctx: owner, organizationId: orgId } = await createSalon(pool, {
      name: 'Stf Role Owner', email: `role-owner@${DOMAIN}`, password: PW,
      salon: 'Stf Check Role', slug: 'staffcheck-role',
    }))
    await setPlan(orgId, 'business')
    const branch = await owner.post('/api/auth/organization/create-team',
      { data: { name: 'Cabang Role', organizationId: orgId } })
    branchId = (await branch.json()).id

    await pool.query(`
      insert into users (id, name, email, email_verified, created_at, updated_at)
      values ('stf_manajer', 'Stf Manajer', 'stf-manajer@staffcheck.local', true, now(), now())`)
    await pool.query(`
      insert into members (id, user_id, organization_id, role, created_at)
      values ('stf_m_manajer', 'stf_manajer', $1, 'manajer', now())`, [orgId])
    await pool.query(`
      insert into team_members (id, team_id, user_id, created_at)
      values ('stf_tm_manajer', $1, 'stf_manajer', now())`, [branchId])
  })
  test.afterAll(async () => {
    await owner.dispose()
    await pool.query(`delete from users where id = 'stf_manajer'`)
  })

  test('a custom-role member with only a team_members row does not block deactivation', async () => {
    const res = await submitForm(owner, `/dashboard/branches/${branchId}`, 'Nonaktifkan cabang</button>')
    expect(res.status).toBe(200)
    expect(res.html).not.toContain('Pindahkan staf berikut lebih dulu')
    const { rows: [branch] } = await pool.query(
      `select active from branch_profiles where team_id = $1`, [branchId])
    expect(branch.active).toBe(false)
    await submitForm(owner, `/dashboard/branches/${branchId}`, 'Aktifkan cabang</button>')
  })

  test('once staff_profiles.team_id is actually set, the same custom-role member blocks deactivation, named', async () => {
    await pool.query(`
      update staff_profiles set team_id = $1
       where user_id = 'stf_manajer' and organization_id = $2`, [branchId, orgId])
    const res = await submitForm(owner, `/dashboard/branches/${branchId}`, 'Nonaktifkan cabang</button>')
    expect(res.html).toContain('Pindahkan staf berikut lebih dulu: Stf Manajer.')
    const { rows: [branch] } = await pool.query(
      `select active from branch_profiles where team_id = $1`, [branchId])
    expect(branch.active).toBe(true)
  })
})

test.describe.serial('departure: deactivation, reactivation, session revocation, password reset', () => {
  let owner: Awaited<ReturnType<typeof client>>
  let orgId: string
  let ownerUserId: string
  let staffId: string

  const activeOf = async (userId: string) => (await pool.query(
    `select active from staff_profiles where user_id = $1 and organization_id = $2`,
    [userId, orgId])).rows[0]?.active as boolean | undefined

  test.beforeAll(async () => {
    ;({ ctx: owner, organizationId: orgId } = await createSalon(pool, {
      name: 'Stf Exit Owner', email: `exit-owner@${DOMAIN}`, password: PW,
      salon: 'Stf Check Exit', slug: 'staffcheck-exit',
    }))
    // Business plan: quota never interferes with departure/reactivation here
    // (the seat-freed claim on the DEFAULT plan gets its own describe block).
    await setPlan(orgId, 'business')
    const { rows: [ownerRow] } = await pool.query(
      `select user_id from members where organization_id = $1 and role = 'owner'`, [orgId])
    ownerUserId = ownerRow.user_id

    const made = await owner.post('/api/staff',
      { data: { name: 'Stf Exit Staff', email: `exit-staff@${DOMAIN}`, password: PW, role: 'admin' } })
    expect(made.status(), await made.text()).toBe(201)
    staffId = (await made.json()).user.id
  })
  test.afterAll(() => owner.dispose())

  test('deactivation revokes sessions -- the same cookie no longer authenticates, and no session row survives (spec 7.11)', async () => {
    const staffClient = await client()
    await staffClient.post('/api/auth/sign-in/email', { data: { email: `exit-staff@${DOMAIN}`, password: PW } })
    // Precondition, asserted rather than assumed: the cookie works BEFORE
    // deactivation.
    const before = await (await staffClient.get('/api/auth/get-session')).json()
    expect(before?.user?.id).toBe(staffId)

    await submitForm(owner, `/dashboard/staff/${staffId}`, 'Nonaktifkan staf</button>', { userId: staffId })
    const after = await (await staffClient.get('/api/auth/get-session')).json()
    expect(after?.user).toBeFalsy()
    const { rows: sessions } = await pool.query(`select 1 from sessions where user_id = $1`, [staffId])
    expect(sessions).toHaveLength(0)
    await staffClient.dispose()
  })

  test('reactivation with room in the plan succeeds', async () => {
    await submitForm(owner, `/dashboard/staff/${staffId}`, 'Aktifkan staf</button>', { userId: staffId })
    expect(await activeOf(staffId)).toBe(true)
  })

  test('password reset revokes sessions -- the pre-reset cookie is dead -- AND the password actually changed (spec 7.11)', async () => {
    const pwClient = await client()
    await pwClient.post('/api/auth/sign-in/email', { data: { email: `exit-staff@${DOMAIN}`, password: PW } })
    const before = await (await pwClient.get('/api/auth/get-session')).json()
    expect(before?.user?.id).toBe(staffId)

    const reset = await submitForm(owner, `/dashboard/staff/${staffId}`, 'name="password"',
      { userId: staffId, password: NEWPW })
    expect(reset.status).toBe(200)
    expect(reset.html).not.toContain('Kata sandi minimal')

    const afterReset = await (await pwClient.get('/api/auth/get-session')).json()
    expect(afterReset?.user).toBeFalsy()
    await pwClient.dispose()

    // A reset that only killed sessions would pass the check above and
    // nothing else -- the password must have actually changed.
    const oldPw = await client()
    const oldRes = await oldPw.post('/api/auth/sign-in/email', { data: { email: `exit-staff@${DOMAIN}`, password: PW } })
    expect(oldRes.status()).not.toBe(200)
    await oldPw.dispose()

    const newPw = await client()
    const newRes = await newPw.post('/api/auth/sign-in/email', { data: { email: `exit-staff@${DOMAIN}`, password: NEWPW } })
    expect(newRes.status()).toBe(200)
    await newPw.dispose()
  })

  test('an owner cannot deactivate themselves, forged from another staff member\'s page with the userId swapped', async () => {
    const selfAttempt = await submitForm(owner, `/dashboard/staff/${staffId}`,
      'Nonaktifkan staf</button>', { userId: ownerUserId })
    expect(selfAttempt.status).toBe(200)
    expect(selfAttempt.html).toContain(SELF_MSG)
    expect(await activeOf(ownerUserId)).toBe(true)

    const ownSelfPage = await getPage(owner, `/dashboard/staff/${ownerUserId}`)
    expect(ownSelfPage.html).not.toContain('Nonaktifkan staf</button>')
  })

  test('handing an admin the owner\'s password would hand them the owner\'s account -- refused, and the owner\'s own password is untouched', async () => {
    const madeAdmin = await owner.post('/api/staff',
      { data: { name: 'Stf Exit Admin', email: `exit-admin@${DOMAIN}`, password: PW, role: 'admin' } })
    expect(madeAdmin.status(), await madeAdmin.text()).toBe(201)
    const adminClient = await client()
    await adminClient.post('/api/auth/sign-in/email', { data: { email: `exit-admin@${DOMAIN}`, password: PW } })

    const res = await submitForm(adminClient, `/dashboard/staff/${ownerUserId}`, 'name="password"',
      { userId: ownerUserId, password: NEWPW })
    expect(res.status).toBe(200)
    expect(res.html).toContain('Hanya pemilik yang dapat mengatur ulang kata sandi pemilik.')
    await adminClient.dispose()

    const stillSignsIn = await client()
    const res2 = await stillSignsIn.post('/api/auth/sign-in/email',
      { data: { email: `exit-owner@${DOMAIN}`, password: PW } })
    expect(res2.status()).toBe(200)
    await stillSignsIn.dispose()
  })

  // lib/session.ts's guard, not its revocation: the row is flipped in SQL
  // directly, so no session is revoked by this write -- exercising the
  // GUARD, which is the only way to reach it (deactivateStaffAction's own
  // path always revokes as part of the same write).
  test('a deactivated login is refused by the page guard, and following every redirect TERMINATES rather than looping', async () => {
    const madeVictim = await owner.post('/api/staff',
      { data: { name: 'Stf Exit Victim', email: `exit-victim@${DOMAIN}`, password: PW, role: 'admin' } })
    expect(madeVictim.status(), await madeVictim.text()).toBe(201)
    const victimId = (await madeVictim.json()).user.id
    await pool.query(
      `update staff_profiles set active = false where user_id = $1 and organization_id = $2`,
      [victimId, orgId])

    // Their credentials still work -- signInEmail knows nothing of
    // staff_profiles -- so signing in again is the NORMAL path for a
    // dismissed employee, not an edge case. Asserted, because it is the
    // precondition that makes the loop reachable at all.
    const dead = await client()
    const signInRes = await dead.post('/api/auth/sign-in/email',
      { data: { email: `exit-victim@${DOMAIN}`, password: PW } })
    expect(signInRes.status(), await signInRes.text()).toBe(200)

    // app/(auth)/layout.tsx bounces anyone holding a session to /dashboard,
    // so a naive ONE-hop check cannot see /dashboard <-> /login trading the
    // request forever. Cap at 8 and require TERMINATION, not one redirect.
    const trapped = await followed(dead, '/dashboard')
    expect(trapped.status, `hops: ${JSON.stringify(trapped.hops)}`).toBe(200)
    expect(trapped.url).toContain('/login')
    expect(trapped.hops, JSON.stringify(trapped.hops)).toHaveLength(1)

    // The root cause, not the symptom: the cookie stopped being live, rather
    // than the two layouts merely disagreeing about a still-valid one.
    const { rows: sessions } = await pool.query(`select 1 from sessions where user_id = $1`, [victimId])
    expect(sessions).toHaveLength(0)

    const deadApi = await client()
    await deadApi.post('/api/auth/sign-in/email', { data: { email: `exit-victim@${DOMAIN}`, password: PW } })
    const apiRes = await deadApi.get('/api/me/entitlements')
    expect(apiRes.status()).toBe(401)
    await deadApi.dispose()
    await dead.dispose()
  })
})

test.describe.serial('departure: the last owner, and the ownerless-salon guards driven through the real screens', () => {
  // The two-connection races that FORCE these guards deterministically live
  // in tests/staff.db.test.ts (they need real lock contention, which a
  // single HTTP actor cannot produce). This proves the single-actor UI path:
  // an admin can never touch an owner, an owner can deactivate a co-owner
  // while two are active, and the two-click sequence that used to reach zero
  // active owners (deactivate co-owner, then self-demote) is refused on its
  // second click.
  let owner: Awaited<ReturnType<typeof client>>
  let orgId: string
  let ownerUserId: string

  const activeOf = async (userId: string) => (await pool.query(
    `select active from staff_profiles where user_id = $1 and organization_id = $2`,
    [userId, orgId])).rows[0]?.active as boolean | undefined
  const roleOf = async (userId: string) => (await pool.query(
    `select role from members where user_id = $1 and organization_id = $2`,
    [userId, orgId])).rows[0]?.role as string | undefined

  test.beforeAll(async () => {
    ;({ ctx: owner, organizationId: orgId } = await createSalon(pool, {
      name: 'Stf Owners Owner', email: `owners-owner@${DOMAIN}`, password: PW,
      salon: 'Stf Check Owners', slug: 'staffcheck-owners',
    }))
    await setPlan(orgId, 'business')
    const { rows: [ownerRow] } = await pool.query(
      `select user_id from members where organization_id = $1 and role = 'owner'`, [orgId])
    ownerUserId = ownerRow.user_id

    // A second owner, raw -- the trigger seeds the profile, exactly as an
    // invitation accepted into the owner role would.
    await pool.query(`
      insert into users (id, name, email, email_verified, created_at, updated_at)
      values ('stf_owner2', 'Stf Owner Two', 'stf-owner2@staffcheck.local', true, now(), now())`)
    await pool.query(`
      insert into members (id, user_id, organization_id, role, created_at)
      values ('stf_m_owner2', 'stf_owner2', $1, 'owner', now())`, [orgId])
  })
  test.afterAll(async () => {
    await owner.dispose()
    await pool.query(`delete from users where id = 'stf_owner2'`)
  })

  test('an admin cannot deactivate an owner, even a co-owner (spec 6.1), and an OWNER can', async () => {
    const madeAdmin = await owner.post('/api/staff',
      { data: { name: 'Stf Owners Admin', email: `owners-admin@${DOMAIN}`, password: PW, role: 'admin' } })
    expect(madeAdmin.status(), await madeAdmin.text()).toBe(201)
    const adminClient = await client()
    await adminClient.post('/api/auth/sign-in/email', { data: { email: `owners-admin@${DOMAIN}`, password: PW } })

    const adminDrops = await submitForm(adminClient, `/dashboard/staff/stf_owner2`,
      'Nonaktifkan staf</button>', { userId: 'stf_owner2' })
    expect(adminDrops.status).toBe(200)
    expect(adminDrops.html).toContain('Hanya pemilik yang dapat menonaktifkan pemilik.')
    expect(await activeOf('stf_owner2')).toBe(true)
    await adminClient.dispose()

    const dropSecond = await submitForm(owner, `/dashboard/staff/stf_owner2`,
      'Nonaktifkan staf</button>', { userId: 'stf_owner2' })
    expect(dropSecond.status).toBe(200)
    expect(dropSecond.html).not.toContain(LAST_OWNER_MSG)
    expect(await activeOf('stf_owner2')).toBe(false)

    await pool.query(`
      update staff_profiles set active = true, deleted_at = null
       where user_id = 'stf_owner2' and organization_id = $1`, [orgId])
  })

  test('two clicks to an ownerless salon: deactivate the co-owner (allowed), then self-demote (refused on the second click)', async () => {
    // Three guards used to disagree about what an owner is:
    // deactivateStaffAction counts owners whose PROFILE is active,
    // better-auth's own guard counts every members row with role owner
    // (active or not) and only on self-demotion, and updateStaffRoleAction
    // had no last-owner clause at all -- so deactivate co-owner B
    // (legitimate), then demote yourself: better-auth still counts B's
    // inactive members row, sees two owners, and allows it.
    const dropCoOwner = await submitForm(owner, `/dashboard/staff/stf_owner2`,
      'Nonaktifkan staf</button>', { userId: 'stf_owner2' })
    expect(dropCoOwner.status).toBe(200)
    expect(await activeOf('stf_owner2')).toBe(false)

    const selfDemote = await submitForm(owner, `/dashboard/staff/${ownerUserId}`,
      'Simpan peran</button>', { userId: ownerUserId, role: 'admin' })
    expect(selfDemote.status).toBe(200)
    expect(selfDemote.html).toContain(LAST_OWNER_MSG)
    expect(selfDemote.html).not.toContain('Peran diperbarui.')
    expect(await roleOf(ownerUserId)).toBe('owner')
  })

  test('an INACTIVE co-owner can still be demoted (direction 1), but the ACTIVE last owner still cannot (direction 2)', async () => {
    // Both directions asserted separately so a future change cannot collapse
    // them back into one test. stf_owner2 is inactive right now (from the
    // previous test) -- not in the active-owner set, so refusing this would
    // leave a deactivated co-owner permanently un-demotable, told they are
    // the last active owner when they are not active at all.
    const demoteInactive = await submitForm(owner, `/dashboard/staff/stf_owner2`,
      'Simpan peran</button>', { userId: 'stf_owner2', role: 'admin' })
    expect(demoteInactive.status).toBe(200)
    expect(demoteInactive.html).not.toContain(LAST_OWNER_MSG)
    expect(await roleOf('stf_owner2')).toBe('admin')

    const demoteLastAgain = await submitForm(owner, `/dashboard/staff/${ownerUserId}`,
      'Simpan peran</button>', { userId: ownerUserId, role: 'admin' })
    expect(demoteLastAgain.status).toBe(200)
    expect(demoteLastAgain.html).toContain(LAST_OWNER_MSG)
    expect(await roleOf(ownerUserId)).toBe('owner')
  })
})

test.describe.serial('the plan cap counts active staff only -- "deactivation frees a seat" proven by a refused hire succeeding afterwards', () => {
  // tests/README.md: "deactivation frees a slot" only has teeth when proven
  // by a creation that was refused actually succeeding afterwards -- a SQL
  // count query would prove nothing about the action itself.
  let owner: Awaited<ReturnType<typeof client>>
  let orgId: string
  let leaverId: string

  test.beforeAll(async () => {
    ;({ ctx: owner, organizationId: orgId } = await createSalon(pool, {
      name: 'Stf Cap Owner', email: `cap-owner@${DOMAIN}`, password: PW,
      salon: 'Stf Check Cap', slug: 'staffcheck-cap',
    }))
  })
  test.afterAll(async () => {
    await owner.dispose()
    await setDefaultStaffCap(FREE.caps.staff)
  })

  test('hiring at a full cap is refused with 402, creates no user, then succeeds once a deactivation frees a seat, and reactivating at the (again full) cap is refused', async () => {
    // Cap 2: the owner holds one seat, so exactly one hire fits.
    await setDefaultStaffCap(2)

    const leaver = await owner.post('/api/staff',
      { data: { name: 'Stf Cap Leaver', email: `cap-leaver@${DOMAIN}`, password: PW, role: 'admin' } })
    expect(leaver.status(), await leaver.text()).toBe(201)
    leaverId = (await leaver.json()).user.id

    const hire = () => owner.post('/api/staff',
      { data: { name: 'Stf Cap Hire', email: `cap-hire@${DOMAIN}`, password: PW, role: 'admin' } })

    const refused = await hire()
    expect(refused.status()).toBe(402)
    const { rows: noHire } = await pool.query(`select 1 from users where email = $1`, [`cap-hire@${DOMAIN}`])
    expect(noHire).toHaveLength(0)

    const left = await submitForm(owner, `/dashboard/staff/${leaverId}`, 'Nonaktifkan staf</button>', { userId: leaverId })
    expect(left.status).toBe(200)

    // The product decision, not a count query: the SAME hire, refused a
    // moment ago, now succeeds.
    const rehire = await hire()
    expect(rehire.status(), await rehire.text()).toBe(201)

    // The cap is full again (owner + the new hire), so rehiring the leaver
    // is refused exactly like hiring.
    const rehireLeaver = await submitForm(owner, `/dashboard/staff/${leaverId}`,
      'Aktifkan staf</button>', { userId: leaverId })
    expect(rehireLeaver.status).toBe(200)
    expect(rehireLeaver.html).toContain(QUOTA_REACTIVATE_MSG)
    const { rows: [stillInactive] } = await pool.query(
      `select active from staff_profiles where user_id = $1 and organization_id = $2`, [leaverId, orgId])
    expect(stillInactive.active).toBe(false)
  })
})

test.describe.serial('/dashboard/staff/import -- bulk creation', () => {
  let owner: Awaited<ReturnType<typeof client>>
  let orgId: string
  let branchName: string
  let branchId: string

  const memberCount = async (id: string) => (await pool.query(
    `select count(*)::int n from members where organization_id = $1`, [id])).rows[0].n as number
  const userExists = async (email: string) => (await pool.query(
    `select 1 from users where email = $1`, [email])).rows.length > 0

  test.beforeAll(async () => {
    ;({ ctx: owner, organizationId: orgId } = await createSalon(pool, {
      name: 'Stf Import Owner', email: `import-owner@${DOMAIN}`, password: PW,
      salon: 'Stf Check Import', slug: 'staffcheck-import',
    }))
    // Business plan: quota never interferes with the validation-focused
    // assertions below -- the seat-shortfall case gets its own capped org.
    await setPlan(orgId, 'business')
    branchName = 'Cabang Impor'
    const branch = await owner.post('/api/auth/organization/create-team',
      { data: { name: branchName, organizationId: orgId } })
    branchId = (await branch.json()).id
  })
  test.afterAll(() => owner.dispose())

  test('a clean file creates every row, each with the right role and branch (spec §7.17)', async () => {
    const adminEmail = `import-admin@${DOMAIN}`
    const stylistEmail = `import-stylist@${DOMAIN}`
    const csv = [
      `Stf Import Admin,${adminEmail},demo12345,admin,`,
      `Stf Import Stylist,${stylistEmail},demo12345,stylist,${branchName}`,
    ].join('\n')
    const res = await submitForm(owner, '/dashboard/staff/import', 'name="csv"', { csv })
    expect(res.status, res.html).toBe(303)
    expect(res.location ?? '').toContain('/dashboard/staff')

    const { rows: [adminRow] } = await pool.query(`
      select m.role, s.team_id from members m
        join users u on u.id = m.user_id
        join staff_profiles s on s.user_id = m.user_id and s.organization_id = m.organization_id
       where u.email = $1 and m.organization_id = $2`, [adminEmail, orgId])
    expect(adminRow?.role).toBe('admin')
    expect(adminRow?.team_id).toBeNull()

    const { rows: [stylistRow] } = await pool.query(`
      select m.role, s.team_id from members m
        join users u on u.id = m.user_id
        join staff_profiles s on s.user_id = m.user_id and s.organization_id = m.organization_id
       where u.email = $1 and m.organization_id = $2`, [stylistEmail, orgId])
    expect(stylistRow?.role).toBe('stylist')
    expect(stylistRow?.team_id).toBe(branchId)
  })

  test('a file with one bad row creates NOTHING -- the row count is unchanged, not 2 of 3 (spec §7.15)', async () => {
    const before = await memberCount(orgId)
    const good1 = `import-bad1@${DOMAIN}`
    const good2 = `import-bad2@${DOMAIN}`
    const bad = `import-badrow@${DOMAIN}`
    const csv = [
      `Stf Import Good1,${good1},demo12345,admin,`,
      `Stf Import Good2,${good2},demo12345,stylist,${branchName}`,
      `Stf Import Bad,${bad},short,admin,`,
    ].join('\n')
    const res = await submitForm(owner, '/dashboard/staff/import', 'name="csv"', { csv })
    expect(res.status).toBe(200)
    expect(res.html).toContain('1 baris gagal divalidasi')
    expect(res.html).toContain('Kata sandi minimal 8 karakter')
    expect(await memberCount(orgId)).toBe(before)
    expect(await userExists(good1)).toBe(false)
    expect(await userExists(good2)).toBe(false)
    expect(await userExists(bad)).toBe(false)
  })

  test('a management row naming a branch is a validation error, and creates nothing (spec §5.4)', async () => {
    const email = `import-mgmt@${DOMAIN}`
    const csv = `Stf Import Mgmt,${email},demo12345,admin,${branchName}`
    const res = await submitForm(owner, '/dashboard/staff/import', 'name="csv"', { csv })
    expect(res.status).toBe(200)
    expect(res.html).toContain('Peran ini tidak ditempatkan di cabang.')
    expect(await userExists(email)).toBe(false)
  })

  test('a quoted field containing a comma parses into the right columns, not a truncated one', async () => {
    // Two branches deliberately chosen so a naive split(',') truncation of
    // the second would collide with the first: "Cabang Jakarta, Selatan"
    // truncated at the comma reads as "Cabang Jakarta" -- exactly the
    // shorter branch's own name.
    const truncationBranch = await owner.post('/api/auth/organization/create-team',
      { data: { name: 'Cabang Jakarta', organizationId: orgId } })
    const truncationBranchId = (await truncationBranch.json()).id
    const commaBranchName = 'Cabang Jakarta, Selatan'
    const commaBranch = await owner.post('/api/auth/organization/create-team',
      { data: { name: commaBranchName, organizationId: orgId } })
    const commaBranchId = (await commaBranch.json()).id
    expect(truncationBranchId).not.toBe(commaBranchId)

    const email = `import-comma@${DOMAIN}`
    const csv = `"Dewi Lestari, S.Kom",${email},demo12345,stylist,"${commaBranchName}"`
    const res = await submitForm(owner, '/dashboard/staff/import', 'name="csv"', { csv })
    expect(res.status, res.html).toBe(303)

    const { rows: [row] } = await pool.query(`
      select u.name, s.team_id from users u
        join staff_profiles s on s.user_id = u.id and s.organization_id = $2
       where u.email = $1`, [email, orgId])
    expect(row?.name).toBe('Dewi Lestari, S.Kom')
    expect(row?.team_id).toBe(commaBranchId)
    expect(row?.team_id).not.toBe(truncationBranchId)
  })

  test('mixed CRLF/LF line endings still import every row -- none silently dropped', async () => {
    // csv-parse 7.0.2 with relax_column_count:false counts columns across a
    // stray \r and skips every row after the first. Posted as a HAND-BUILT
    // multipart body, not through Playwright's `multipart` option: like
    // undici's FormData, it normalises every \n in a field value to \r\n, so
    // a normal post cannot put mixed endings on the wire at all -- it would
    // pass with the normalisation removed, exactly the vacuous assertion
    // tests/README.md warns about.
    const e1 = `import-crlf1@${DOMAIN}`
    const e2 = `import-crlf2@${DOMAIN}`
    const e3 = `import-crlf3@${DOMAIN}`
    const csv = `Stf Import Crlf1,${e1},demo12345,admin,\r\n`
      + `Stf Import Crlf2,${e2},demo12345,stylist,${branchName}\n`
      + `Stf Import Crlf3,${e3},demo12345,admin,`

    const page = await getPage(owner, '/dashboard/staff/import')
    const form = page.html.split('<form').find((f) => f.includes('name="csv"'))!
    const fields = hiddenFieldsOf(form).map(([, k, v]) => [decodeHtml(k), decodeHtml(v ?? '')] as [string, string])
    fields.push(['csv', csv])
    const boundary = `----staffcheck${Date.now()}`
    const rawBody = fields.map(([k, v]) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('')
      + `--${boundary}--\r\n`
    const state = await owner.storageState()
    const cookieHeader = state.cookies.map((c) => `${c.name}=${c.value}`).join('; ')
    const res = await fetch(`${BASE_URL}/dashboard/staff/import`, {
      method: 'POST',
      headers: {
        cookie: cookieHeader,
        origin: BASE_URL,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      body: rawBody,
      redirect: 'manual',
    })
    expect(res.status, await res.text()).toBe(303)
    expect(res.headers.get('location') ?? '').toContain('/dashboard/staff')
    expect(await userExists(e1)).toBe(true)
    expect(await userExists(e2)).toBe(true)
    expect(await userExists(e3)).toBe(true)
  })

  test.describe('needing more seats than remain returns one error naming the shortfall, and creates nothing (spec §7.16)', () => {
    test('the import page shows the seat budget before a file is even chosen, and a two-row file against one remaining seat is refused as a whole', async () => {
      const { ctx: seatOwner, organizationId: seatOrgId } = await createSalon(pool, {
        name: 'Stf Import Seat Owner', email: `import-seat@${DOMAIN}`, password: PW,
        salon: 'Stf Check Import Seat', slug: 'staffcheck-import-seat',
      })
      try {
        // Cap 2: the owner holds one seat, so exactly one more fits -- a
        // two-row file needs two and must be refused as a whole.
        await setDefaultStaffCap(2)

        const importPage = await getPage(seatOwner, '/dashboard/staff/import')
        expect(importPage.html).toContain('Sisa kuota staf: 1 dari 2')

        const s1 = `import-short1@${DOMAIN}`
        const s2 = `import-short2@${DOMAIN}`
        const csv = [
          `Stf Import Short1,${s1},demo12345,admin,`,
          `Stf Import Short2,${s2},demo12345,admin,`,
        ].join('\n')
        const before = await memberCount(seatOrgId)
        const res = await submitForm(seatOwner, '/dashboard/staff/import', 'name="csv"', { csv })
        expect(res.status).toBe(200)
        expect(res.html).toContain('Butuh 2 kursi staf, tersisa 1.')
        expect(await memberCount(seatOrgId)).toBe(before)
        expect(await userExists(s1)).toBe(false)
        expect(await userExists(s2)).toBe(false)
      } finally {
        await seatOwner.dispose()
        await setDefaultStaffCap(FREE.caps.staff)
      }
    })
  })

  test.describe('mid-commit failure triggers compensation -- made DATA-DRIVEN, not time-driven', () => {
    // THE FLAKY TEST THIS REPLACES: the original fired a 3-row import, waited
    // setTimeout(500), then closed a branch to force failure mid-commit.
    // That 500ms was a race against real network/hashing latency -- close
    // too early and the row fails at VALIDATION (nothing to compensate,
    // proving a weaker claim); too late and the whole import finishes with
    // nothing to undo. Observed failing up to 4 assertions and passing on
    // rerun.
    //
    // Fix: a temporary BEFORE INSERT trigger on `members` (the table
    // provisionStaff's addMember call writes, once per staff row) that
    // raises on the SECOND insert for this run's own organization. Row one
    // commits, row two fails -- every run, no timing, no production code
    // touched. Scoped to a captured baseline (this org's member count before
    // the import starts, i.e. the owner alone) rather than an absolute
    // count, so the owner's own pre-existing row never counts as the first
    // "import" insert.
    const triggerName = 'vt_staff_import_second_insert_fails'

    const installTrigger = (orgId: string, baseline: number) => pool.query(`
      create or replace function ${triggerName}() returns trigger
      language plpgsql as $$
      begin
        if new.organization_id = '${orgId}' then
          if (select count(*) from members where organization_id = '${orgId}') > ${baseline} then
            raise exception 'vt_staff_import_forced_failure: test-only, row already at baseline + 1';
          end if;
        end if;
        return new;
      end;
      $$;
      create trigger ${triggerName}
        before insert on members
        for each row execute function ${triggerName}()`)

    const dropTrigger = () => pool.query(`drop trigger if exists ${triggerName} on members`)
      .then(() => pool.query(`drop function if exists ${triggerName}()`))

    test('sanity: the trigger fires on a raw insert past baseline, and only for the org it targets -- verified before relying on it through the app', async () => {
      const { ctx: sanityOwner, organizationId: sanityOrgId } = await createSalon(pool, {
        name: 'Stf Trigger Sanity Owner', email: `trigger-sanity@${DOMAIN}`, password: PW,
        salon: 'Stf Check Trigger Sanity', slug: 'staffcheck-trigger-sanity',
      })
      const { ctx: otherOwner, organizationId: otherOrgId } = await createSalon(pool, {
        name: 'Stf Trigger Other Owner', email: `trigger-other@${DOMAIN}`, password: PW,
        salon: 'Stf Check Trigger Other', slug: 'staffcheck-trigger-other',
      })
      const baseline = await memberCount(sanityOrgId)
      expect(baseline).toBe(1) // the owner alone

      await installTrigger(sanityOrgId, baseline)
      try {
        await pool.query(`
          insert into users (id, name, email, email_verified, created_at, updated_at)
          values ('vt_trigger_sanity_1', 'Sanity One', 'trigger-sanity-1@staffcheck.local', true, now(), now())`)
        await pool.query(`
          insert into members (id, user_id, organization_id, role, created_at)
          values ('vt_trigger_sanity_m1', 'vt_trigger_sanity_1', $1, 'admin', now())`, [sanityOrgId])

        // The SECOND insert for THIS org past baseline is refused.
        await pool.query(`
          insert into users (id, name, email, email_verified, created_at, updated_at)
          values ('vt_trigger_sanity_2', 'Sanity Two', 'trigger-sanity-2@staffcheck.local', true, now(), now())`)
        await expect(pool.query(`
          insert into members (id, user_id, organization_id, role, created_at)
          values ('vt_trigger_sanity_m2', 'vt_trigger_sanity_2', $1, 'admin', now())`, [sanityOrgId]))
          .rejects.toThrow(/vt_staff_import_forced_failure/)

        // A DIFFERENT org, past its own single-member baseline, is
        // untouched -- the trigger is scoped to the org it targets, not
        // global.
        await pool.query(`
          insert into users (id, name, email, email_verified, created_at, updated_at)
          values ('vt_trigger_other_1', 'Other One', 'trigger-other-1@staffcheck.local', true, now(), now())`)
        await expect(pool.query(`
          insert into members (id, user_id, organization_id, role, created_at)
          values ('vt_trigger_other_m1', 'vt_trigger_other_1', $1, 'admin', now())`, [otherOrgId]))
          .resolves.toBeTruthy()
      } finally {
        await dropTrigger()
        await pool.query(`delete from users where id like 'vt_trigger_%'`)
        await sanityOwner.dispose()
        await otherOwner.dispose()
      }
    })

    test('row one commits, row two fails inside the commit loop (not validation), and compensation undoes row one -- every run', async () => {
      const { ctx: compOwner, organizationId: compOrgId } = await createSalon(pool, {
        name: 'Stf Import Comp Owner', email: `import-comp-owner@${DOMAIN}`, password: PW,
        salon: 'Stf Check Import Comp', slug: 'staffcheck-import-comp',
      })
      // Business plan: this test is about the compensation path, not quota.
      await setPlan(compOrgId, 'business')
      const baseline = await memberCount(compOrgId)
      expect(baseline).toBe(1)
      await installTrigger(compOrgId, baseline)

      try {
        const email1 = `import-comp1@${DOMAIN}`
        const email2 = `import-comp2@${DOMAIN}`
        const csv = [
          `Stf Import Comp1,${email1},demo12345,admin,`,
          `Stf Import Comp2,${email2},demo12345,admin,`,
        ].join('\n')
        const res = await submitForm(compOwner, '/dashboard/staff/import', 'name="csv"', { csv })

        expect(res.status, res.html).toBe(200) // not redirected -- the import failed
        expect(res.html).not.toContain('baris gagal divalidasi') // proves it passed VALIDATION
        expect(res.html).toContain('telah dibatalkan') // reported as a cancelled compensation
        // Exactly one row committed before the forced failure -- not zero
        // (which would mean it never got past validation) and not two
        // (which would mean the trigger never fired).
        expect(res.html).toContain('1 staf yang sempat dibuat telah dibatalkan')

        expect(await memberCount(compOrgId)).toBe(baseline)
        expect(await userExists(email1)).toBe(false)
        expect(await userExists(email2)).toBe(false)
      } finally {
        await dropTrigger()
        await compOwner.dispose()
      }
    })
  })
})

/**
 * Task 5's FilterBar on /dashboard/staff: `active` is the same segmented-link
 * control as customers.spec.ts's "the URL controls" suite; `branch` is the
 * validator-backed one -- a GET form (a native submit replaces the whole
 * query string with only its own named inputs, so it needs preservedFields,
 * not listHref) -- folded out of a bare, un-contracted `?branch=` read
 * (Task 5's scope point (a)). Modelled directly on that suite's fixture
 * shape, cut down to what proves the mechanics rather than paging depth,
 * which tests/staff.db.test.ts's own paging describe already covers.
 */
test.describe('the URL controls', () => {
  const CTRL_DOMAIN = 'staffurl.local'
  const CTRL_SLUG = 'staffurl'

  let owner: Awaited<ReturnType<typeof createSalon>>['ctx']
  let orgId: string
  let branchAId: string
  const ownerCookies = async () => (await owner.storageState()).cookies

  test.beforeAll(async () => {
    await pool.query(`delete from organizations where slug like 'staffurl%'`)
    await pool.query(`delete from users where email like $1`, [`%@${CTRL_DOMAIN}`])

    const salon = await createSalon(pool, {
      name: 'Ctrl Owner', email: `owner@${CTRL_DOMAIN}`, password: PW,
      salon: 'Ctrl Salon', slug: CTRL_SLUG,
    })
    owner = salon.ctx
    orgId = salon.organizationId
    // The free plan's staff cap (3) would refuse the owner plus the two
    // stylists seeded below.
    await setPlan(orgId, 'business')

    const branch = await owner.post('/api/auth/organization/create-team',
      { data: { name: 'Cabang Ctrl', organizationId: orgId } })
    branchAId = (await branch.json()).id

    // Two stylists sharing a name, one placed at the branch -- enough to
    // give the `branch` filter real work without paging-scale fixtures
    // (those already live in tests/staff.db.test.ts's `listStaff filters`
    // describe).
    for (let i = 0; i < 2; i++) {
      const id = `e2e_sturl_${i}`
      await pool.query(`
        insert into users (id, name, email, email_verified, created_at, updated_at)
        values ($1, 'Budi Santoso', $2, true, now(), now())`, [id, `${id}@${CTRL_DOMAIN}`])
      await pool.query(`
        insert into members (id, user_id, organization_id, role, created_at)
        values ($1, $2, $3, 'stylist', now())`, [`${id}_m`, id, orgId])
    }
    await pool.query(`
      update staff_profiles set team_id = $1
       where organization_id = $2 and user_id = 'e2e_sturl_0'`, [branchAId, orgId])
  })

  test.afterAll(async () => {
    await owner.dispose()
    await pool.query(`delete from organizations where slug like 'staffurl%'`)
    await pool.query(`delete from users where email like $1`, [`%@${CTRL_DOMAIN}`])
  })

  // A single predicate requiring every condition AT ONCE, not several
  // chained toHaveURL calls: goto's own URL already satisfies some of them
  // (sort=-name, page=1, active=true depending on the test), so a first
  // assertion checking only one would trivially pass on the STALE
  // pre-navigation URL before the click/submit's own navigation has landed
  // -- a false pass this suite caught once against a deliberately broken
  // listHref call and had to be rewritten this way to actually catch.
  test('choosing a branch keeps the sort and resets the page', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto('/dashboard/staff?sort=-name&page=2')
    await page.locator('select[name="branch"]').selectOption(branchAId)
    await page.getByRole('button', { name: 'Filter' }).click()
    await expect(page).toHaveURL((url) =>
      url.searchParams.get('sort') === '-name'
      && url.searchParams.get('branch') === branchAId
      && !url.searchParams.has('page'))
  })

  test('choosing a branch resets an existing page number', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto('/dashboard/staff?page=2')
    await page.locator('select[name="branch"]').selectOption(branchAId)
    await page.getByRole('button', { name: 'Filter' }).click()
    await expect(page).not.toHaveURL(/page=/)
  })

  test('the active filter is a link, and it keeps the sort too', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto('/dashboard/staff?sort=-name')
    await page.getByRole('link', { name: 'Aktif', exact: true }).click()
    await expect(page).toHaveURL((url) =>
      url.searchParams.get('sort') === '-name' && url.searchParams.get('active') === 'true')
  })

  test('picking a branch keeps the active filter already set', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto('/dashboard/staff?active=true')
    await page.locator('select[name="branch"]').selectOption(branchAId)
    await page.getByRole('button', { name: 'Filter' }).click()
    await expect(page).toHaveURL((url) =>
      url.searchParams.get('active') === 'true' && url.searchParams.get('branch') === branchAId)
  })
})

/**
 * Task 5: deactivateSelectedStaffAction (app/dashboard/(shell)/staff/actions.ts).
 * The headline case §7/task-5-brief.md asks for: a bulk call over a stylist
 * AND the last remaining owner must report exactly done: 1, refused: 1 --
 * not "2 dinonaktifkan" as if the owner had gone too. The pure SQL guard
 * (migration 0025's last-active-owner CTE) is already proven directly in
 * tests/bulk.db.test.ts; this is the same shape one layer up, through the
 * actual screen, where the admin-vs-owner guard fires first for the very
 * same reason -- a non-owner admin can never bulk-deactivate the org's only
 * owner, whichever guard catches it.
 */
test.describe('bulk deactivation: a stylist and the last remaining owner', () => {
  const BULK_DOMAIN = 'staffbulk.local'

  let ownerCtx: Awaited<ReturnType<typeof createSalon>>['ctx']
  let adminCtx: Awaited<ReturnType<typeof signIn>>
  let ownerUserId: string
  let stylistUserId: string
  let organizationId: string

  test.beforeAll(async () => {
    await pool.query(`delete from organizations where slug like 'staffbulk%'`)
    await pool.query(`delete from users where email like $1`, [`%@${BULK_DOMAIN}`])

    const salon = await createSalon(pool, {
      name: 'Bulk Owner', email: `owner@${BULK_DOMAIN}`, password: PW,
      salon: 'Bulk Salon', slug: 'staffbulk',
    })
    ownerCtx = salon.ctx
    ownerUserId = salon.userId
    organizationId = salon.organizationId
    await setPlan(salon.organizationId, 'business')

    // A plain admin -- distinct from the owner -- does the bulk deactivating.
    const adminUserId = await createLogin(pool, {
      name: 'Bulk Admin', email: `admin@${BULK_DOMAIN}`, password: PW,
    })
    await pool.query(`
      insert into members (id, user_id, organization_id, role, created_at)
      values ($1, $2, $3, 'admin', now())`, [`${adminUserId}_m`, adminUserId, salon.organizationId])

    stylistUserId = await createLogin(pool, {
      name: 'Bulk Stylist', email: `stylist@${BULK_DOMAIN}`, password: PW,
    })
    await pool.query(`
      insert into members (id, user_id, organization_id, role, created_at)
      values ($1, $2, $3, 'stylist', now())`, [`${stylistUserId}_m`, stylistUserId, salon.organizationId])

    adminCtx = await signIn(`admin@${BULK_DOMAIN}`, PW)
    await adminCtx.post('/api/auth/organization/set-active', { data: { organizationId: salon.organizationId } })
  })

  test.afterAll(async () => {
    await ownerCtx.dispose()
    await adminCtx.dispose()
    await pool.query(`delete from organizations where slug like 'staffbulk%'`)
    await pool.query(`delete from users where email like $1`, [`%@${BULK_DOMAIN}`])
  })

  test('reports the refusal instead of claiming both rows went', async ({ page }) => {
    await page.context().addCookies((await adminCtx.storageState()).cookies)
    await page.goto('/dashboard/staff')

    await page.getByRole('row', { name: /Bulk Stylist/ }).getByRole('checkbox').check()
    await page.getByRole('row', { name: /Bulk Owner/ }).getByRole('checkbox').check()
    await expect(page.getByTestId('selection-count')).toContainText('2')

    await page.getByRole('button', { name: 'Nonaktifkan yang dipilih' }).click()

    // The dishonest report this task exists to prevent: "2 dinonaktifkan."
    // would be false -- the owner never moved. The message must name BOTH
    // numbers, and why the refusal happened.
    await expect(page.getByTestId('bulk-message')).toContainText(
      '1 dinonaktifkan, 1 ditolak (pemilik terakhir tidak bisa dinonaktifkan).')

    const { rows } = await pool.query(
      `select user_id, active from staff_profiles where user_id = any($1)`,
      [[stylistUserId, ownerUserId]])
    const activeOf = Object.fromEntries(rows.map((r) => [r.user_id, r.active])) as Record<string, boolean>
    expect(activeOf[stylistUserId], 'the stylist actually deactivated').toBe(false)
    expect(activeOf[ownerUserId], 'the last owner was refused, not silently deactivated').toBe(true)
  })

  test('bulk-deactivating an already-inactive staff member is not a false last-owner refusal', async ({ page }) => {
    // deactivateStaff's UPDATE is `WHERE ... AND active`, so an already-
    // inactive row closes nothing -- the same `false` the SQL returns for a
    // genuine last-owner refusal. The admin filters to "Nonaktif" and every
    // row there carries a checkbox regardless of `active`, so this is a real
    // path, not a theoretical one: it must NOT read as "pemilik terakhir
    // tidak bisa dinonaktifkan" for a row that was already a harmless no-op.
    const retiredUserId = await createLogin(pool, {
      name: 'Bulk Retired', email: `retired@${BULK_DOMAIN}`, password: PW,
    })
    await pool.query(`
      insert into members (id, user_id, organization_id, role, created_at)
      values ($1, $2, $3, 'stylist', now())`, [`${retiredUserId}_m`, retiredUserId, organizationId])
    await pool.query(`
      update staff_profiles set active = false, deleted_at = now(), deleted_by = $1
       where user_id = $2 and organization_id = $3`, [ownerUserId, retiredUserId, organizationId])

    await page.context().addCookies((await adminCtx.storageState()).cookies)
    await page.goto('/dashboard/staff?active=false')

    await page.getByRole('row', { name: /Bulk Retired/ }).getByRole('checkbox').check()
    await expect(page.getByTestId('selection-count')).toContainText('1')

    await page.getByRole('button', { name: 'Nonaktifkan yang dipilih' }).click()

    const message = page.getByTestId('bulk-message')
    await expect(message).toContainText('1 dinonaktifkan.')
    await expect(message, 'a harmless no-op must not be blamed on the last owner').not.toContainText('ditolak')

    const { rows } = await pool.query(
      `select active from staff_profiles where user_id = $1`, [retiredUserId])
    expect(rows[0].active, 'still inactive, unaffected by the no-op').toBe(false)
  })
})
