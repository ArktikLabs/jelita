import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool, Client } from 'pg'
import { TEST_DATABASE_URL } from './db'

/**
 * Services catalogue schema, the seeding trigger/backfill, cross-tenant FK
 * refusals, the service_branch_pricing resolution view, and the
 * create-vs-currency-change concurrency race -- asserted against a real
 * Postgres, same reasoning as branch.db.test.ts and plan.db.test.ts. Screens,
 * guards, form posts and the plan cap live in tests/e2e/service.spec.ts
 * instead: the cap is requireQuota enforced through the real action, and
 * "deactivation frees a slot" only has teeth when proven by a creation that
 * was refused actually succeeding afterwards -- a SQL count query would prove
 * nothing about the action itself.
 */
const pool = new Pool({ connectionString: TEST_DATABASE_URL })
const ORG = 'vt_service_org'
const ORG2 = 'vt_service_org2'

beforeAll(async () => {
  await pool.query(`delete from organizations where id = any($1)`, [[ORG, ORG2]])
  await pool.query(`delete from users where id = 'vt_svc_u2'`)
})

afterAll(async () => {
  await pool.query(`delete from organizations where id = any($1)`, [[ORG, ORG2]])
  await pool.query(`delete from users where id = 'vt_svc_u2'`)
  await pool.end()
})

describe('schema', () => {
  it('all five service tables exist', async () => {
    const { rows } = await pool.query(`
      select table_name from information_schema.tables
       where table_name in ('salon_profiles','service_categories','services',
                            'service_branch_overrides','service_staff')`)
    expect(rows).toHaveLength(5)
  })

  it('RLS is enabled on all five', async () => {
    const { rows } = await pool.query(`
      select relname from pg_class
       where relname in ('salon_profiles','service_categories','services',
                         'service_branch_overrides','service_staff')
         and relrowsecurity`)
    expect(rows).toHaveLength(5)
  })
})

describe('the trigger seeds salon settings', () => {
  beforeAll(() => pool.query(`
    insert into organizations (id, name, slug, created_at)
    values ($1, 'Service DB Test', 'vt-service', now())`, [ORG]))

  it('a new salon gets a profile, defaulting to IDR', async () => {
    const { rows: [seeded] } = await pool.query(
      `select currency from salon_profiles where organization_id = $1`, [ORG])
    expect(seeded).toBeDefined()
    expect(seeded.currency).toBe('IDR')
  })

  // Regression for the backfill (db/migrations/0010_services.sql): an
  // organization with no profile row would have no currency, and every price
  // on it unreadable.
  it('every existing salon has a profile', async () => {
    const { rows: [orphan] } = await pool.query(`
      select count(*)::int n from organizations o
       where not exists (select 1 from salon_profiles p
                          where p.organization_id = o.id)`)
    expect(orphan.n).toBe(0)
  })
})

describe('cross-tenant rows are unrepresentable', () => {
  beforeAll(async () => {
    await pool.query(`
      insert into organizations (id, name, slug, created_at)
      values ($1, 'Service DB Test 2', 'vt-service2', now())`, [ORG2])
    await pool.query(`
      insert into teams (id, name, organization_id, created_at)
      values ('vt_svc_t2', 'Other Branch', $1, now())`, [ORG2])
    await pool.query(`
      insert into services (id, organization_id, name, duration_minutes, price)
      values ('vt_svc_s1', $1, 'Potong Rambut', 60, 150000)`, [ORG])
    await pool.query(`
      insert into users (id, name, email, email_verified, created_at, updated_at)
      values ('vt_svc_u2', 'Other Staff', 'vt-svc-u2@test.local', true, now(), now())`)
    await pool.query(`
      insert into members (id, user_id, organization_id, role, created_at)
      values ('vt_svc_m2', 'vt_svc_u2', $1, 'member', now())`, [ORG2])
  })

  it('an override pointing at another salon branch is refused', async () => {
    // ORG's service, ORG2's branch, ORG's organization_id -- the composite FK
    // must refuse this outright, not leave it to a WHERE clause somewhere.
    await expect(pool.query(`
      insert into service_branch_overrides (service_id, team_id, organization_id, price)
      values ('vt_svc_s1', 'vt_svc_t2', $1, 99)`, [ORG])).rejects.toThrow()
  })

  it('a staff link pointing at another salon staff member is refused', async () => {
    // members_seed_staff_profile (0009) auto-creates the staff_profiles row
    // when the member is inserted, so ORG2's vt_svc_u2 already has one --
    // just not under ORG.
    await expect(pool.query(`
      insert into service_staff (service_id, user_id, organization_id)
      values ('vt_svc_s1', 'vt_svc_u2', $1)`, [ORG])).rejects.toThrow()
  })
})

describe('service_branch_pricing resolves the effective price per branch', () => {
  const priceAt = async (serviceId: string, teamId: string) => {
    const { rows } = await pool.query(`
      select price, offered, currency from service_branch_pricing
       where service_id = $1 and team_id = $2`, [serviceId, teamId])
    return rows[0]
  }

  beforeAll(async () => {
    await pool.query(`
      insert into teams (id, name, organization_id, created_at)
      values ('vt_svc_t1', 'Cabang Satu', $1, now())`, [ORG])
    // Never given an override row, for the whole suite below -- proves the
    // active check applies even where an override never existed.
    await pool.query(`
      insert into teams (id, name, organization_id, created_at)
      values ('vt_svc_t3', 'Cabang Tanpa Override', $1, now())`, [ORG])
    await pool.query(`
      insert into services (id, organization_id, name, duration_minutes, price)
      values ('vt_svc_s2', $1, 'Creambath', 45, 90000)`, [ORG2])
    await pool.query(`update salon_profiles set currency = 'SGD' where organization_id = $1`, [ORG2])
  })

  it('no override resolves to the salon price', async () => {
    expect(Number((await priceAt('vt_svc_s1', 'vt_svc_t1')).price)).toBe(150000)
  })

  it('an override resolves to the branch price', async () => {
    await pool.query(`
      insert into service_branch_overrides (service_id, team_id, organization_id, price)
      values ('vt_svc_s1', 'vt_svc_t1', $1, 180000)`, [ORG])
    expect(Number((await priceAt('vt_svc_s1', 'vt_svc_t1')).price)).toBe(180000)
  })

  it('resolution carries the currency', async () => {
    expect((await priceAt('vt_svc_s1', 'vt_svc_t1')).currency).toBe('IDR')
  })

  // Every fixture above uses the IDR default, so a hardcoded 'IDR' literal in
  // the view -- or a join that resolved the wrong organization's profile --
  // would still read IDR and pass. A second salon on a different currency in
  // the same run proves the join is per-organization.
  it("a different salon on a different currency resolves its own, and the first salon still resolves IDR", async () => {
    expect((await priceAt('vt_svc_s2', 'vt_svc_t2')).currency).toBe('SGD')
    expect((await priceAt('vt_svc_s1', 'vt_svc_t1')).currency).toBe('IDR')
  })

  it('offered = false hides it at that branch', async () => {
    await pool.query(`
      update service_branch_overrides set offered = false
       where service_id = 'vt_svc_s1' and team_id = 'vt_svc_t1'`)
    expect((await priceAt('vt_svc_s1', 'vt_svc_t1')).offered).toBe(false)
    await pool.query(`
      update service_branch_overrides set offered = true
       where service_id = 'vt_svc_s1' and team_id = 'vt_svc_t1'`)
  })

  it('an inactive service is hidden everywhere, with or without an override row', async () => {
    await pool.query(`update services set active = false where id = 'vt_svc_s1'`)
    expect((await priceAt('vt_svc_s1', 'vt_svc_t1')).offered).toBe(false)
    // vt_svc_t3 never had an override row at all. An implementation like
    // `case when o.service_id is null then true else s.active and o.offered
    // end` would apply the active check only where an override exists, pass
    // the assertion above, and still show an inactive service as bookable at
    // every branch that never had one -- the common case for most branches.
    expect((await priceAt('vt_svc_s1', 'vt_svc_t3')).offered).toBe(false)
    await pool.query(`update services set active = true where id = 'vt_svc_s1'`)
  })

  // The deliberate pair: an override equal to the salon price must NOT
  // collapse into "inheriting", and a genuinely inheriting branch MUST follow
  // a salon price change. Each alone passes against a degenerate model (e.g.
  // treating any non-null override price as authoritative regardless of
  // whether it matches, or treating "no override row differs from salon
  // price" as the inheriting signal) -- only together do they pin the
  // correct one: an override row's mere EXISTENCE, not its value, is what
  // marks a branch as no longer following the salon.
  it('an override equal to the salon price does NOT follow a salon change, while an inheriting branch DOES', async () => {
    await pool.query(`
      update service_branch_overrides set price = 150000
       where service_id = 'vt_svc_s1' and team_id = 'vt_svc_t1'`)
    await pool.query(`update services set price = 200000 where id = 'vt_svc_s1'`)
    expect(Number((await priceAt('vt_svc_s1', 'vt_svc_t1')).price)).toBe(150000)

    await pool.query(`
      update service_branch_overrides set price = null
       where service_id = 'vt_svc_s1' and team_id = 'vt_svc_t1'`)
    expect(Number((await priceAt('vt_svc_s1', 'vt_svc_t1')).price)).toBe(200000)

    // restore for any later test in this file
    await pool.query(`update services set price = 150000 where id = 'vt_svc_s1'`)
  })
})

describe('service creation vs. currency change: never both land', () => {
  // Mirrors the exact statements in app/dashboard/services/actions.ts
  // (createServiceAction, setCurrencyAction) against two independent
  // connections, so both lock orderings are forced deterministically instead
  // of hoped for via Promise.all timing. A bare `for update` is NOT
  // sufficient on its own: EvalPlanQual only re-checks the LOCKED row's own
  // columns against a concurrent write, so a `not exists` subquery against a
  // DIFFERENT table (services) still runs against the snapshot the statement
  // started with. That is why setCurrencyAction issues its `not exists` check
  // as a FRESH statement after the lock, and why createServiceAction folds a
  // `currency = $current` check into the very statement that takes the lock.
  const insertService = (client: Client, orgId: string, currency: string, price: number) =>
    client.query(`
      insert into services (id, organization_id, name, duration_minutes, price)
      select $1, $2, 'Layanan Race', 30, $3
        from salon_profiles
       where organization_id = $2 and currency = $4
         for update`, [`race_svc_${orgId}`, orgId, price, currency])

  const setup = async (id: string) => {
    await pool.query(`delete from organizations where id = $1`, [id])
    await pool.query(`
      insert into organizations (id, name, slug, created_at)
      values ($1, $1, $1, now())`, [id])
  }

  const currencyOf = async (orgId: string) => (await pool.query(
    `select currency from salon_profiles where organization_id = $1`, [orgId])).rows[0].currency

  const serviceOf = async (orgId: string) => (await pool.query(
    `select price from services where organization_id = $1`, [orgId])).rows[0]

  afterAll(() => pool.query(
    `delete from organizations where id = any($1)`, [['vt_race_a', 'vt_race_b']]))

  it('currency-change wins the lock first: the blocked create is refused, not corrupted', async () => {
    const orgId = 'vt_race_a'
    await setup(orgId)
    const curClient = new Client({ connectionString: TEST_DATABASE_URL })
    const svcClient = new Client({ connectionString: TEST_DATABASE_URL })
    await curClient.connect()
    await svcClient.connect()
    try {
      await curClient.query('begin')
      // Takes the row lock first -- createServiceAction's insert will block
      // on it below.
      await curClient.query(
        `select 1 from salon_profiles where organization_id = $1 for update`, [orgId])

      // The service create reads currency ('IDR') BEFORE attempting the
      // insert, exactly like createServiceAction's separate salonCurrency()
      // read -- then blocks on the row lock.
      const blockedCreate = insertService(svcClient, orgId, 'IDR', 50000)

      // The currency change proceeds and commits while the create is still
      // blocked (no service exists yet, so its own `not exists` passes).
      const updateResult = await curClient.query(`
        update salon_profiles set currency = 'SGD', updated_at = now()
         where organization_id = $1
           and not exists (select 1 from services where organization_id = $1)`, [orgId])
      expect(updateResult.rowCount).toBe(1)
      await curClient.query('commit')

      // Now unblocked: a FRESH statement, so it sees the committed SGD --
      // its own `currency = 'IDR'` (captured before the race) no longer
      // matches, so it inserts nothing.
      const createResult = await blockedCreate
      expect(createResult.rowCount).toBe(0)

      expect(await currencyOf(orgId)).toBe('SGD')
      expect(await serviceOf(orgId)).toBeUndefined()
    } finally {
      await curClient.end()
      await svcClient.end()
    }
  })

  it('service-create wins the lock first: the blocked currency change is refused, not corrupted', async () => {
    const orgId = 'vt_race_b'
    await setup(orgId)
    const curClient = new Client({ connectionString: TEST_DATABASE_URL })
    const svcClient = new Client({ connectionString: TEST_DATABASE_URL })
    await curClient.connect()
    await svcClient.connect()
    try {
      await svcClient.query('begin')
      const createResult = await insertService(svcClient, orgId, 'IDR', 50000)
      expect(createResult.rowCount).toBe(1)

      // The currency change's lock-acquisition blocks on svcClient's open
      // transaction.
      await curClient.query('begin')
      const blockedLock = curClient.query(
        `select 1 from salon_profiles where organization_id = $1 for update`, [orgId])

      await svcClient.query('commit')

      // Now unblocked, holding the lock post-commit -- its FRESH `not
      // exists` check now sees the committed service and refuses.
      await blockedLock
      const updateResult = await curClient.query(`
        update salon_profiles set currency = 'SGD', updated_at = now()
         where organization_id = $1
           and not exists (select 1 from services where organization_id = $1)`, [orgId])
      expect(updateResult.rowCount).toBe(0)
      await curClient.query('commit')

      expect(await currencyOf(orgId)).toBe('IDR')
      expect(Number((await serviceOf(orgId)).price)).toBe(50000)
    } finally {
      await curClient.end()
      await svcClient.end()
    }
  })
})
