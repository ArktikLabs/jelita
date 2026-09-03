import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from './db'

/**
 * The staff seat cap, enforced in the database.
 *
 * requireQuota counts and then the caller creates, so two creates at
 * `used = cap - 1` both passed. Like the ownerless-salon race this could not
 * be fixed in application code: better-auth's addMember writes the members row
 * through its own adapter, so no application transaction covers the count and
 * the write together.
 *
 * At the table, with two connections, for that reason.
 */
const pool = new Pool({ connectionString: TEST_DATABASE_URL })

const ORG = 'seat_org'
/** The free plan's staff cap. */
const CAP = 3
/**
 * The owner holds one of them.
 *
 * Every organization has an owner -- onboarding creates the salon and that
 * membership together, and since migration 0025 the database refuses to be
 * left without one. So a free-plan salon has CAP - 1 seats to give away, and
 * a fixture that pretends otherwise is modelling a salon that cannot exist.
 */
const SPARE = CAP - 1

const setPlan = (key: string) => pool.query(`
  update subscriptions set plan_id = (select id from plans where key = $2)
   where organization_id = $1`, [ORG, key])

const seats = async () => Number((await pool.query(`
  select count(*)::int n from members m
   where m.organization_id = $1
     and coalesce((select s.active from staff_profiles s
                    where s.user_id = m.user_id and s.organization_id = m.organization_id),
                  true)`, [ORG])).rows[0].n)

/** Either the pool or a dedicated client, since the race needs two of the
 *  latter. Both expose `query`, which is all this needs. */
type Queryable = { query: (text: string, values?: unknown[]) => Promise<unknown> }

const addMember = (n: number, client: Queryable = pool) =>
  client.query(`
    insert into members (id, user_id, organization_id, role, created_at)
    values ($1, $1, $2, 'stylist', now())`, [`seat_u${n}`, ORG])

beforeAll(async () => {
  await pool.query(`delete from organizations where id = $1`, [ORG])
  await pool.query(`
    insert into organizations (id, name, slug, created_at)
    values ($1, 'Seat', 'seat-one', now())`, [ORG])
  for (const id of [...Array.from({ length: 12 }, (_, n) => `seat_u${n}`), 'seat_owner']) {
    await pool.query(`
      insert into users (id, name, email, email_verified, created_at, updated_at)
      values ($1, $1, $1 || '@seat.local', true, now(), now())
      on conflict (id) do nothing`, [id])
  }
  await pool.query(`
    insert into members (id, user_id, organization_id, role, created_at)
    values ('seat_owner_m', 'seat_owner', $1, 'owner', now())`, [ORG])
})

afterAll(async () => {
  await pool.query(`delete from organizations where id = $1`, [ORG])
  await pool.query(`delete from users where id like 'seat_u%'`)
  await pool.end()
})

beforeEach(async () => {
  // The owner stays: removing them is refused, correctly (migration 0025).
  await pool.query(`delete from members where organization_id = $1
                     and user_id like 'seat_u%'`, [ORG])
  await pool.query(`update staff_profiles set active = true where organization_id = $1`, [ORG])
  await setPlan('free')
})

describe('the staff seat cap', () => {
  it('allows exactly the cap, owner included', async () => {
    for (let n = 0; n < SPARE; n++) await addMember(n)
    expect(await seats()).toBe(CAP)
  })

  it('refuses the one past it', async () => {
    for (let n = 0; n < SPARE; n++) await addMember(n)
    await expect(addMember(SPARE)).rejects.toThrow(/over its staff cap/)
    expect(await seats(), 'and the seat is not taken').toBe(CAP)
  })

  it('frees a seat when somebody is deactivated', async () => {
    for (let n = 0; n < SPARE; n++) await addMember(n)
    await pool.query(`update staff_profiles set active = false
                       where user_id = 'seat_u0' and organization_id = $1`, [ORG])
    await expect(addMember(SPARE), 'a departure returns the seat').resolves.toBeTruthy()
  })

  it('lets an unlimited plan past it entirely', async () => {
    await setPlan('business')
    for (let n = 0; n < 8; n++) await addMember(n)
    // Eight plus the owner: business has no plan_limits row for staff, which
    // requireQuota and the trigger both read as unlimited.
    expect(await seats()).toBe(9)
  })

  it('refuses TWO CONCURRENT creates at cap - 1 -- only one seat is left', async () => {
    // The gap this closes. Both transactions count 2 against a cap of 3 and
    // both pass their own check; without the organization-row lock in the
    // trigger, both commits also pass and the salon lands one seat over.
    for (let n = 0; n < SPARE - 1; n++) await addMember(n)

    const a = await pool.connect()
    const b = await pool.connect()
    try {
      await a.query('begin')
      await b.query('begin')

      // Determinism here has been hard, and two earlier versions of this test
      // passed against a deliberately unlocked trigger:
      //
      //   `insert().then(commit)` on both -- serialises by promise ordering.
      //   `allSettled` on both inserts -- deadlocks, because b blocks on a's
      //   lock and a cannot commit until the await resolves.
      //   insert a, issue b, commit a -- a's commit can land before b's insert
      //   reaches the server, and then b sees the committed row either way.
      //
      // What actually distinguishes the two is the SEAT COUNT at the end, so
      // that is what is asserted -- and `a` only commits once `b` is provably
      // blocked (or has already finished, which is what happens with no lock).
      await addMember(10, a)
      const bInsert = addMember(11, b).then(() => 'ok' as const, () => 'refused' as const)

      let settled = false
      bInsert.then(() => { settled = true })
      for (let i = 0; i < 200 && !settled; i++) {
        const { rows } = await pool.query(`
          select count(*)::int n from pg_stat_activity
           where wait_event_type = 'Lock' and state = 'active'`)
        if (rows[0].n > 0) break
        await new Promise((r) => setTimeout(r, 25))
      }
      await a.query('commit')

      if (await bInsert === 'ok') await b.query('commit')
      else await b.query('rollback')
    } finally {
      await a.query('rollback').catch(() => {})
      await b.query('rollback').catch(() => {})
      a.release()
      b.release()
    }
    expect(await seats(), 'never over the cap').toBe(CAP)
  })

  it('counts a member with NO profile row as holding a seat', async () => {
    // A missing profile must never hand out a free seat -- countResource says
    // so, and the trigger has to agree or the two disagree at the boundary.
    for (let n = 0; n < SPARE; n++) await addMember(n)
    await pool.query(`delete from staff_profiles
                       where user_id = 'seat_u0' and organization_id = $1`, [ORG])
    await expect(addMember(SPARE)).rejects.toThrow(/over its staff cap/)
  })
})
