import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from './db'

/**
 * The resolution rule, asserted against real Postgres.
 *
 * Booking computes every slot from this function, so a wrong answer here is
 * either a customer booked with an absent stylist or a stylist idle behind an
 * empty calendar. That is why it lives in SQL and why the tests call it
 * directly rather than re-implementing the rule.
 */
const pool = new Pool({ connectionString: TEST_DATABASE_URL })

const ORG = 'sched_org'
const ORG2 = 'sched_org2'
const TEAM = 'sched_team'
const USER = 'sched_stylist'
const OTHER_USER = 'sched_other'

// A Wednesday, and the Wednesday after it.
const WED = '2026-09-09'
const NEXT_WED = '2026-09-16'
const WEDNESDAY = 3

const hoursOn = async (date: string, userId = USER, org = ORG) => {
  const { rows } = await pool.query(
    `select opens_at, closes_at from staff_working_hours($1, $2, $3::date)`,
    [userId, org, date])
  return rows.map((r) => `${String(r.opens_at).slice(0, 5)}-${String(r.closes_at).slice(0, 5)}`)
}

const setBranchDay = (closed: boolean, opens = '09:00', closes = '21:00') =>
  pool.query(
    `update branch_hours set closed = $2, opens_at = $3, closes_at = $4
      where team_id = $1 and weekday = $5`,
    [TEAM, closed, opens, closes, WEDNESDAY])

const setStaffDay = (closed: boolean, opens = '09:00', closes = '21:00') =>
  pool.query(
    `update staff_hours set closed = $3, opens_at = $4, closes_at = $5
      where user_id = $1 and organization_id = $2 and weekday = $6`,
    [USER, ORG, closed, opens, closes, WEDNESDAY])

beforeAll(async () => {
  await pool.query(`delete from organizations where id = any($1)`, [[ORG, ORG2]])
  await pool.query(`
    insert into organizations (id, name, slug, created_at)
    values ($1, 'Sched', 'sched', now()), ($2, 'Sched Two', 'sched-two', now())`,
    [ORG, ORG2])

  // Every organization has an owner, because in production every one does:
  // onboarding creates the salon and the creator's owner membership together.
  // A fixture without one is a state the product cannot reach, and since
  // migration 0025 the database says so -- deactivating anybody in an
  // ownerless salon is refused as "would be left with no active owner".
  for (const [org, id] of [[ORG, 'sched_fixture_owner'], [ORG2, 'sched_fixture_owner2']] as const) {
    await pool.query(`
      insert into users (id, name, email, email_verified, created_at, updated_at)
      values ($1, $1, $1 || '@fixture.local', true, now(), now())
      on conflict (id) do nothing`, [id])
    await pool.query(`
      insert into members (id, user_id, organization_id, role, created_at)
      values ($1 || '_owner_m', $1, $2, 'owner', now())`, [id, org])
  }
  await pool.query(`
    insert into teams (id, name, organization_id, created_at)
    values ($1, 'Cabang Sched', $2, now())`, [TEAM, ORG])
  for (const [id, org] of [[USER, ORG], [OTHER_USER, ORG2]] as const) {
    await pool.query(`
      insert into users (id, name, email, email_verified, created_at, updated_at)
      values ($1, $1, $1 || '@sched.local', true, now(), now())`, [id])
    await pool.query(`
      insert into members (id, user_id, organization_id, role, created_at)
      values ($1 || '_m', $1, $2, 'stylist', now())`, [id, org])
  }
  // The members insert seeded staff_profiles (and staff_hours by trigger);
  // assignment to a branch is a separate write.
  await pool.query(
    `update staff_profiles set team_id = $1 where user_id = $2 and organization_id = $3`,
    [TEAM, USER, ORG])
})

afterAll(async () => {
  await pool.query(`delete from organizations where id = any($1)`, [[ORG, ORG2]])
  await pool.end()
})

beforeEach(async () => {
  await setBranchDay(false)
  await setStaffDay(false)
  await pool.query(`delete from staff_schedule_exceptions where organization_id = $1`, [ORG])
  await pool.query(`update staff_profiles set active = true, team_id = $1
                     where user_id = $2 and organization_id = $3`, [TEAM, USER, ORG])
})

describe('staff_working_hours', () => {
  it('seeds seven weekdays for a new staff member', async () => {
    const { rows } = await pool.query(
      `select count(*)::int n from staff_hours where user_id = $1 and organization_id = $2`,
      [USER, ORG])
    expect(rows[0].n).toBe(7)
  })

  it('is genuinely set-returning', async () => {
    // Asserted against the catalogue, not inferred from a call that happens to
    // yield one row: a function returning a single row and one returning a set
    // of one are indistinguishable at the call site, and callers iterating is
    // the whole point of the signature (spec 2.4).
    const { rows } = await pool.query(
      `select proretset from pg_proc where proname = 'staff_working_hours'`)
    expect(rows[0].proretset).toBe(true)
  })

  it('returns the pattern when nothing overrides it', async () => {
    expect(await hoursOn(WED)).toEqual(['09:00-21:00'])
  })

  it('returns nothing when the branch is closed, whatever the staff pattern says', async () => {
    await setBranchDay(true)
    await setStaffDay(false, '09:00', '21:00')
    expect(await hoursOn(WED)).toEqual([])
  })

  it('returns nothing when the staff member is closed that weekday', async () => {
    await setStaffDay(true)
    expect(await hoursOn(WED)).toEqual([])
  })

  it('clamps both ends to the branch', async () => {
    await setBranchDay(false, '09:00', '21:00')
    await setStaffDay(false, '08:00', '22:00')
    expect(await hoursOn(WED)).toEqual(['09:00-21:00'])
  })

  it('returns nothing when the intervals are disjoint', async () => {
    await setBranchDay(false, '09:00', '12:00')
    await setStaffDay(false, '14:00', '20:00')
    // Not a negative-length interval -- no row at all.
    expect(await hoursOn(WED)).toEqual([])
  })

  it('lets an exception replace the day', async () => {
    await pool.query(`
      insert into staff_schedule_exceptions
        (user_id, organization_id, on_date, closed, opens_at, closes_at)
      values ($1, $2, $3::date, false, '13:00', '17:00')`, [USER, ORG, WED])
    expect(await hoursOn(WED)).toEqual(['13:00-17:00'])
  })

  it('affects only that date, not the same weekday next week', async () => {
    await pool.query(`
      insert into staff_schedule_exceptions
        (user_id, organization_id, on_date, closed, opens_at, closes_at)
      values ($1, $2, $3::date, false, '13:00', '17:00')`, [USER, ORG, WED])
    expect(await hoursOn(NEXT_WED)).toEqual(['09:00-21:00'])
  })

  it('lets a closed exception take a normal day off', async () => {
    await pool.query(`
      insert into staff_schedule_exceptions (user_id, organization_id, on_date, closed)
      values ($1, $2, $3::date, true)`, [USER, ORG, WED])
    expect(await hoursOn(WED)).toEqual([])
  })

  it('lets an exception ADD a day the pattern marks closed', async () => {
    await setStaffDay(true)
    await pool.query(`
      insert into staff_schedule_exceptions
        (user_id, organization_id, on_date, closed, opens_at, closes_at)
      values ($1, $2, $3::date, false, '10:00', '15:00')`, [USER, ORG, WED])
    expect(await hoursOn(WED)).toEqual(['10:00-15:00'])
  })

  it('returns nothing for a staff member with no branch', async () => {
    await pool.query(`update staff_profiles set team_id = null
                       where user_id = $1 and organization_id = $2`, [USER, ORG])
    expect(await hoursOn(WED)).toEqual([])
  })

  it('returns nothing for a deactivated staff member', async () => {
    await pool.query(`update staff_profiles set active = false
                       where user_id = $1 and organization_id = $2`, [USER, ORG])
    expect(await hoursOn(WED)).toEqual([])
  })
})

describe('cross-tenant rows are refused by the database', () => {
  it('refuses an exception naming another salon member', async () => {
    await expect(pool.query(`
      insert into staff_schedule_exceptions (user_id, organization_id, on_date, closed)
      values ($1, $2, $3::date, true)`, [OTHER_USER, ORG, WED]))
      .rejects.toThrow(/staff_exception_person_fk/)
  })

  it('refuses an exception that is open but carries no hours', async () => {
    // This constraint is what makes the resolution safe: without it an open
    // exception with null hours would fall through to the pattern's hours,
    // and no assertion on the function itself could distinguish that.
    await expect(pool.query(`
      insert into staff_schedule_exceptions (user_id, organization_id, on_date, closed)
      values ($1, $2, $3::date, false)`, [USER, ORG, WED]))
      .rejects.toThrow(/staff_exception_times/)
  })

  it('refuses a time-off block with an inverted window', async () => {
    await expect(pool.query(`
      insert into staff_time_off (id, user_id, organization_id, on_date, starts_at, ends_at)
      values ('sched_bad', $1, $2, $3::date, '15:00', '13:00')`, [USER, ORG, WED]))
      .rejects.toThrow(/staff_time_off_times/)
  })

  it('allows several blocks on one date -- two errands are two blocks', async () => {
    await pool.query(`
      insert into staff_time_off (id, user_id, organization_id, on_date, starts_at, ends_at)
      values ('sched_b1', $1, $2, $3::date, '11:00', '12:00'),
             ('sched_b2', $1, $2, $3::date, '15:00', '16:00')`, [USER, ORG, WED])
    const { rows } = await pool.query(
      `select count(*)::int n from staff_time_off where user_id = $1 and on_date = $2::date`,
      [USER, WED])
    expect(rows[0].n).toBe(2)
  })
})
