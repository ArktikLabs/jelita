import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from './db'
import {
  createBooking, listBookings, listSlots, rescheduleBooking, setBookingStatus,
} from '../lib/booking'
import { assignedStaff, listBranches } from '../lib/branch'

/**
 * The double-booking guarantee, asserted against real Postgres.
 *
 * These go straight at the constraint rather than through the app on purpose:
 * spec 3.3 is the guarantee and lib/booking.ts is only the polite path to it.
 * An assertion that only exercises the polite path proves nothing about what
 * happens when two requests both read "free" before either writes.
 */
const pool = new Pool({ connectionString: TEST_DATABASE_URL })

const ORG = 'bkg_org'
const ORG2 = 'bkg_org2'
const TEAM = 'bkg_team'
const TEAM2 = 'bkg_team2'
const STYLIST = 'bkg_stylist'
const OTHER_STYLIST = 'bkg_stylist2'
const FOREIGN_STYLIST = 'bkg_foreign'
const CUSTOMER = 'bkg_customer'
const FOREIGN_CUSTOMER = 'bkg_customer_foreign'
const SERVICE = 'bkg_service'

const DAY = '2026-09-09'

let n = 0
const book = (
  { at, until, staff = STYLIST, status = 'pending', customer = CUSTOMER,
    service = SERVICE, org = ORG, team = TEAM }:
  { at: string; until: string; staff?: string; status?: string; customer?: string
    service?: string; org?: string; team?: string },
) => pool.query(
  `insert into bookings (id, organization_id, team_id, staff_user_id, customer_id,
                         service_id, starts_at, ends_at, status,
                         duration_minutes, price, currency)
   values ($1, $2, $3, $4, $5, $6, $7::timestamp, $8::timestamp, $9, 60, 150000, 'IDR')
   returning id`,
  [`bkg_${n++}`, org, team, staff, customer, service,
   `${DAY} ${at}`, `${DAY} ${until}`, status])

beforeAll(async () => {
  await pool.query(`delete from organizations where id = any($1)`, [[ORG, ORG2]])
  await pool.query(`
    insert into organizations (id, name, slug, created_at)
    values ($1, 'Bkg', 'bkg', now()), ($2, 'Bkg Two', 'bkg-two', now())`, [ORG, ORG2])

  // Every organization has an owner, because in production every one does:
  // onboarding creates the salon and the creator's owner membership together.
  // A fixture without one is a state the product cannot reach, and since
  // migration 0025 the database says so -- deactivating anybody in an
  // ownerless salon is refused as "would be left with no active owner".
  // Business: this fixture has more staff than the free plan's three seats,
  // and since migration 0026 the database enforces that cap rather than
  // trusting requireQuota to have been called. A salon with five people is
  // not on the free tier.
  await pool.query(`
    update subscriptions set plan_id = (select id from plans where key = 'business')
     where organization_id = any($1)`, [[ORG, ORG2]])
  for (const [org, id] of [[ORG, 'bkg_fixture_owner'], [ORG2, 'bkg_fixture_owner2']] as const) {
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
    values ($1, 'Cabang Bkg', $2, now()), ($3, 'Cabang Bkg2', $4, now())`,
    [TEAM, ORG, TEAM2, ORG2])
  for (const [id, org, team] of [
    [STYLIST, ORG, TEAM], [OTHER_STYLIST, ORG, TEAM], [FOREIGN_STYLIST, ORG2, TEAM2],
  ] as const) {
    await pool.query(`
      insert into users (id, name, email, email_verified, created_at, updated_at)
      values ($1, $1, $1 || '@bkg.local', true, now(), now())`, [id])
    await pool.query(`
      insert into members (id, user_id, organization_id, role, created_at)
      values ($1 || '_m', $1, $2, 'stylist', now())`, [id, org])
    await pool.query(`update staff_profiles set team_id = $1
                       where user_id = $2 and organization_id = $3`, [team, id, org])
  }
  for (const [id, org] of [[CUSTOMER, ORG], [FOREIGN_CUSTOMER, ORG2]] as const) {
    await pool.query(`
      insert into customers (id, organization_id, name)
      values ($1, $2, 'Pelanggan')`, [id, org])
  }
  await pool.query(`
    insert into services (id, organization_id, name, duration_minutes, price)
    values ($1, $2, 'Potong', 60, 150000)`, [SERVICE, ORG])
})

/** Wednesday, matching DAY -- the weekday both hours tables are keyed by. */
const WEDNESDAY = 3

const setGrid = (minutes: number) => pool.query(
  `update salon_profiles set slot_minutes = $2 where organization_id = $1`, [ORG, minutes])

/** Duration AND price together: a test that mutates the service must not leak
 *  its terms into the next one, and price is snapshotted onto bookings. */
const setService = (minutes: number, price = 150000) => pool.query(
  `update services set duration_minutes = $2, price = $3 where id = $1`,
  [SERVICE, minutes, price])

const linkStylists = async (...ids: string[]) => {
  await pool.query(`delete from service_staff where service_id = $1`, [SERVICE])
  for (const id of ids) {
    await pool.query(
      `insert into service_staff (service_id, user_id, organization_id) values ($1, $2, $3)`,
      [SERVICE, id, ORG])
  }
}

/** Slot start times, as HH:MM. */
const slots = async (staff: string | null = null) => {
  const { rows } = await pool.query(
    `select to_char(starts_at, 'HH24:MI') t from available_slots($1, $2, $3, $4::date, $5)`,
    [ORG, TEAM, SERVICE, DAY, staff])
  return rows.map((r) => r.t as string)
}

/** Slot start times paired with who can take them -- the "any available" fan-out. */
const slotsByStylist = async () => {
  const { rows } = await pool.query(
    `select to_char(starts_at, 'HH24:MI') t, staff_user_id from available_slots($1, $2, $3, $4::date, null)`,
    [ORG, TEAM, SERVICE, DAY])
  return rows.map((r) => `${r.t} ${r.staff_user_id}`)
}

afterAll(async () => {
  await pool.query(`delete from organizations where id = any($1)`, [[ORG, ORG2]])
  await pool.end()
})

beforeEach(async () => {
  await pool.query(`delete from bookings where organization_id = any($1)`, [[ORG, ORG2]])
  await pool.query(`delete from staff_time_off where organization_id = $1`, [ORG])
  await pool.query(`delete from service_branch_overrides where service_id = $1`, [SERVICE])
  await pool.query(`update branch_hours set closed = false, opens_at = '09:00',
                     closes_at = '21:00' where team_id = $1`, [TEAM])
  await pool.query(`update staff_hours set closed = false, opens_at = '09:00',
                     closes_at = '21:00' where organization_id = $1`, [ORG])
  await pool.query(`update staff_profiles set active = true where organization_id = $1`, [ORG])
  await setGrid(30)
  await setService(60)
  await linkStylists(STYLIST)
})

describe('the double-booking constraint', () => {
  it('refuses a second booking overlapping the first for the same stylist', async () => {
    await book({ at: '10:00', until: '11:00' })
    await expect(book({ at: '10:30', until: '11:30' }))
      .rejects.toThrow(/bookings_no_overlap/)
  })

  it('allows back-to-back bookings that share an endpoint', async () => {
    // '[)' bounds. With '[]' this pair collides and every salon running
    // consecutive appointments is broken (spec 3.3).
    await book({ at: '10:00', until: '11:00' })
    await expect(book({ at: '11:00', until: '12:00' })).resolves.toBeTruthy()
  })

  it('allows the same time for a DIFFERENT stylist', async () => {
    await book({ at: '10:00', until: '11:00' })
    await expect(book({ at: '10:00', until: '11:00', staff: OTHER_STYLIST }))
      .resolves.toBeTruthy()
  })

  it('does not hold the slot once cancelled, and holds it again after rebooking', async () => {
    const { rows } = await book({ at: '10:00', until: '11:00' })
    await pool.query(`update bookings set status = 'cancelled' where id = $1`, [rows[0].id])
    await expect(book({ at: '10:00', until: '11:00' })).resolves.toBeTruthy()
    // ...and the released slot is genuinely held again by its replacement.
    await expect(book({ at: '10:30', until: '11:30' }))
      .rejects.toThrow(/bookings_no_overlap/)
  })

  it('does not hold the slot for a no-show, and does for pending and confirmed', async () => {
    for (const status of ['cancelled', 'no_show'] as const) {
      await pool.query(`delete from bookings where organization_id = $1`, [ORG])
      await book({ at: '10:00', until: '11:00', status })
      await expect(book({ at: '10:00', until: '11:00' }),
        `${status} must release the slot`).resolves.toBeTruthy()
    }
    for (const status of ['pending', 'confirmed'] as const) {
      await pool.query(`delete from bookings where organization_id = $1`, [ORG])
      await book({ at: '10:00', until: '11:00', status })
      await expect(book({ at: '10:00', until: '11:00' }),
        `${status} must hold the slot`).rejects.toThrow(/bookings_no_overlap/)
    }
  })

  it('refuses two concurrent inserts for the same slot -- exactly one wins', async () => {
    // Two connections, both past their own read of "free". This is the case
    // application-level checking cannot cover and the constraint exists for.
    const a = new Pool({ connectionString: TEST_DATABASE_URL })
    const b = new Pool({ connectionString: TEST_DATABASE_URL })
    try {
      const insert = (p: Pool, id: string) => p.query(
        `insert into bookings (id, organization_id, team_id, staff_user_id,
                               customer_id, service_id, starts_at, ends_at,
                               status, duration_minutes, price, currency)
         values ($1, $2, $3, $4, $5, $6, $7::timestamp, $8::timestamp,
                 'pending', 60, 150000, 'IDR')`,
        [id, ORG, TEAM, STYLIST, CUSTOMER, SERVICE, `${DAY} 14:00`, `${DAY} 15:00`])
      const results = await Promise.allSettled([insert(a, 'bkg_race_a'), insert(b, 'bkg_race_b')])
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
    } finally {
      await a.end()
      await b.end()
    }
  })
})

describe('what the database refuses outright', () => {
  it('refuses a booking whose end is not after its start', async () => {
    await expect(book({ at: '10:00', until: '10:00' })).rejects.toThrow(/bookings_times/)
  })

  it('refuses a status outside the five', async () => {
    await expect(book({ at: '10:00', until: '11:00', status: 'tentative' }))
      .rejects.toThrow(/bookings_status/)
  })

  it('refuses a stylist from another salon', async () => {
    await expect(book({ at: '10:00', until: '11:00', staff: FOREIGN_STYLIST }))
      .rejects.toThrow(/bookings_staff_fk/)
  })

  it('refuses a customer from another salon', async () => {
    await expect(book({ at: '10:00', until: '11:00', customer: FOREIGN_CUSTOMER }))
      .rejects.toThrow(/bookings_customer_fk/)
  })

  it('refuses a branch from another salon', async () => {
    await expect(book({ at: '10:00', until: '11:00', team: TEAM2 }))
      .rejects.toThrow(/bookings_org_team_fk/)
  })

  it('refuses a slot grid outside the allow-list', async () => {
    await expect(pool.query(
      `update salon_profiles set slot_minutes = 7 where organization_id = $1`, [ORG]))
      .rejects.toThrow(/salon_profiles_slot_minutes/)
  })

  it('defaults a new salon to a 30-minute grid', async () => {
    const { rows } = await pool.query(
      `select slot_minutes from salon_profiles where organization_id = $1`, [ORG])
    expect(rows[0].slot_minutes).toBe(30)
  })
})

describe('available_slots', () => {
  it('steps the salon grid across the working day', async () => {
    const s = await slots()
    expect(s[0]).toBe('09:00')
    expect(s[1]).toBe('09:30')
    // 09:00-21:00 with a 60-minute service: the last start that still fits is
    // 20:00, and 09:00..20:00 on a 30-minute grid is 23 starts.
    expect(s.at(-1)).toBe('20:00')
    expect(s).toHaveLength(23)
  })

  it('aligns a 45-minute grid to the OPENING TIME, not to midnight', async () => {
    await setGrid(45)
    expect((await slots()).slice(0, 3)).toEqual(['09:00', '09:45', '10:30'])
  })

  it('offers only starts where the whole service fits before closing', async () => {
    await setService(90)
    const s = await slots()
    expect(s.at(-1)).toBe('19:30')
    expect(s).not.toContain('20:00')
  })

  it('offers nothing when the service is longer than the working day', async () => {
    await setService(24 * 60)
    expect(await slots()).toEqual([])
  })

  it('drops exactly the starts an existing booking covers, and no more', async () => {
    await book({ at: '10:00', until: '11:00' })
    const s = await slots()
    // 09:30-10:30 overlaps, so it goes. 09:00-10:00 ends exactly when the
    // booking starts -- '[)' bounds, so it survives.
    expect(s).toContain('09:00')
    expect(s).not.toContain('09:30')
    expect(s).not.toContain('10:00')
    expect(s).not.toContain('10:30')
    expect(s).toContain('11:00')
  })

  it('ignores a cancelled booking, exactly as the constraint does', async () => {
    const { rows } = await book({ at: '10:00', until: '11:00' })
    await pool.query(`update bookings set status = 'cancelled' where id = $1`, [rows[0].id])
    expect(await slots()).toContain('10:00')
  })

  it('drops the starts a time-off block covers, leaving the windows either side', async () => {
    await pool.query(`
      insert into staff_time_off (id, user_id, organization_id, on_date, starts_at, ends_at)
      values ('bkg_off', $1, $2, $3::date, '13:00', '15:00')`, [STYLIST, ORG, DAY])
    const s = await slots()
    expect(s).toContain('12:00')      // 12:00-13:00 ends when the block starts
    expect(s).not.toContain('12:30')
    expect(s).not.toContain('14:00')
    expect(s).not.toContain('14:30')  // 14:30-15:30 still overlaps the block
    expect(s).toContain('15:00')
  })

  it('offers nothing when the branch is closed, or the stylist is', async () => {
    await pool.query(`update branch_hours set closed = true
                       where team_id = $1 and weekday = $2`, [TEAM, WEDNESDAY])
    expect(await slots()).toEqual([])
    await pool.query(`update branch_hours set closed = false
                       where team_id = $1 and weekday = $2`, [TEAM, WEDNESDAY])
    await pool.query(`update staff_hours set closed = true
                       where user_id = $1 and organization_id = $2 and weekday = $3`,
      [STYLIST, ORG, WEDNESDAY])
    expect(await slots()).toEqual([])
  })

  it('offers nothing for a service the branch does not offer', async () => {
    await pool.query(`
      insert into service_branch_overrides (service_id, team_id, organization_id, offered)
      values ($1, $2, $3, false)`, [SERVICE, TEAM, ORG])
    expect(await slots()).toEqual([])
  })

  it('offers nothing for a stylist not linked to the service', async () => {
    await linkStylists(OTHER_STYLIST)
    expect(await slots(STYLIST)).toEqual([])
    expect(await slots(OTHER_STYLIST)).not.toEqual([])
  })

  it('offers nothing for a deactivated stylist', async () => {
    await pool.query(`update staff_profiles set active = false
                       where user_id = $1 and organization_id = $2`, [STYLIST, ORG])
    expect(await slots()).toEqual([])
  })

  it('fans out across every qualified stylist when none is named', async () => {
    await linkStylists(STYLIST, OTHER_STYLIST)
    const pairs = await slotsByStylist()
    expect(pairs).toContain(`10:00 ${STYLIST}`)
    expect(pairs).toContain(`10:00 ${OTHER_STYLIST}`)
    // Booking one leaves the OTHER still offering that time -- the reason
    // "any available" is a fan-out and not a single stylist (spec 2.4).
    await book({ at: '10:00', until: '11:00' })
    const after = await slotsByStylist()
    expect(after).not.toContain(`10:00 ${STYLIST}`)
    expect(after).toContain(`10:00 ${OTHER_STYLIST}`)
  })

  it('changes which starts are OFFERED when the grid changes, and nothing already booked', async () => {
    // Booked late in the day so it cannot itself remove the early starts
    // this asserts on.
    const { rows } = await book({ at: '16:00', until: '17:00' })
    await setGrid(20)
    expect((await slots()).slice(0, 3)).toEqual(['09:00', '09:20', '09:40'])
    const { rows: after } = await pool.query(
      `select to_char(starts_at, 'HH24:MI') s, to_char(ends_at, 'HH24:MI') e
         from bookings where id = $1`, [rows[0].id])
    expect(after[0]).toEqual({ s: '16:00', e: '17:00' })
  })

  it('iterates EVERY interval staff_working_hours returns, not just the first', async () => {
    // The constraint scheduling spec 2.4 exists for. The function can only
    // yield one row today, so the only honest way to assert the caller
    // iterates is to make it yield two -- replaced inside a transaction and
    // rolled back, since DDL in Postgres is transactional.
    const c = await pool.connect()
    try {
      await c.query('begin')
      await c.query(`
        create or replace function staff_working_hours(
          p_user_id text, p_organization_id text, p_date date)
        returns table (opens_at time, closes_at time)
        language sql stable as $fn$
          select * from (values ('09:00'::time, '11:00'::time),
                                ('15:00'::time, '17:00'::time)) v;
        $fn$`)
      const { rows } = await c.query(
        `select to_char(starts_at, 'HH24:MI') t from available_slots($1, $2, $3, $4::date, null)`,
        [ORG, TEAM, SERVICE, DAY])
      const t = rows.map((r) => r.t as string)
      // Both windows, each stopping where a 60-minute service stops fitting.
      expect(t).toEqual(['09:00', '09:30', '10:00', '15:00', '15:30', '16:00'])
    } finally {
      await c.query('rollback')
      c.release()
    }
  })
})

describe('the working owner (PRD 5.1: owners who cut hair)', () => {
  const OWNER = 'bkg_owner'

  beforeEach(async () => {
    await pool.query(`delete from bookings where organization_id = $1`, [ORG])
    await pool.query(`delete from users where id = $1`, [OWNER])
    await pool.query(`
      insert into users (id, name, email, email_verified, created_at, updated_at)
      values ($1, 'Bu Pemilik', $1 || '@bkg.local', true, now(), now())`, [OWNER])
    await pool.query(`
      insert into members (id, user_id, organization_id, role, created_at)
      values ($1 || '_m', $1, $2, 'owner', now())`, [OWNER, ORG])
  })

  it('is not bookable until placed at a branch, and is after', async () => {
    await pool.query(
      `insert into service_staff (service_id, user_id, organization_id) values ($1, $2, $3)`,
      [SERVICE, OWNER, ORG])
    // Linked to the service but with no branch: available_slots needs
    // staff_profiles.team_id, so this is the gap the old invariant created.
    expect(await slots(OWNER)).toEqual([])

    await pool.query(`update staff_profiles set team_id = $1
                       where user_id = $2 and organization_id = $3`, [TEAM, OWNER, ORG])
    expect(await slots(OWNER), 'an owner who cuts hair must be bookable').not.toEqual([])
  })

  it('does not block closing the branch they work at, and is not counted as stationed there', async () => {
    // Through assignedStaff and listBranches themselves, not a copy of their
    // SQL: an inlined re-write of the query passes whatever the real one does,
    // which is exactly how an assertion ends up proving only the copy.
    const before = await assignedStaff(TEAM, ORG)
    await pool.query(`update staff_profiles set team_id = $1
                       where user_id = $2 and organization_id = $3`, [TEAM, OWNER, ORG])

    const after = await assignedStaff(TEAM, ORG)
    expect(after, 'an owner is not stranded by closing a branch they own')
      .toEqual(before)
    expect(after).not.toContain('Bu Pemilik')

    const [branch] = await listBranches(ORG, TEAM)
    expect(branch.staffCount, 'and does not inflate the stationed headcount')
      .toBe(before.length)
  })

  it('is_stationed denies the salon-wide pair and treats everything else as stationed', async () => {
    const { rows } = await pool.query(`
      select is_stationed('stylist') a, is_stationed('owner') b,
             is_stationed('admin') c, is_stationed('owner,admin') d,
             is_stationed('owner,stylist') e,
             -- A runtime-defined role (dynamicAccessControl). It must still
             -- block a branch closure: an allow-list would strand them
             -- silently, which tests/e2e/staff.spec.ts asserts against.
             is_stationed('manajer') f,
             -- ...and a lookalike must not be mistaken for the real thing.
             is_stationed('branch-admin-assistant') g,
             is_stationed(null) h`)
    expect(rows[0]).toEqual({
      a: true, b: false, c: false, d: false, e: true, f: true, g: true, h: true,
    })
  })
})

describe('createBooking', () => {
  const args = (over: Partial<Parameters<typeof createBooking>[0]> = {}) => ({
    organizationId: ORG, teamId: TEAM, serviceId: SERVICE, customerId: CUSTOMER,
    date: DAY, startsAt: `${DAY}T10:00`, ...over,
  })

  it('drops starts already in the past, which the SQL function still offers', async () => {
    // 2020-09-09 is also a Wednesday, so the working pattern applies and
    // available_slots fills the day. The filter that empties it lives in
    // lib/booking.ts, deliberately (spec 4) -- asserting both halves is what
    // shows it is the filter doing the work and not an empty schedule.
    const past = '2020-09-09'
    const { rows } = await pool.query(
      `select count(*)::int n from available_slots($1, $2, $3, $4::date, null)`,
      [ORG, TEAM, SERVICE, past])
    expect(rows[0].n, 'the SQL function itself still offers them').toBeGreaterThan(0)
    expect(await listSlots({
      organizationId: ORG, teamId: TEAM, serviceId: SERVICE, date: past,
    })).toEqual([])
  })

  it('books the requested stylist and snapshots the terms', async () => {
    const id = await createBooking(args({ staffUserId: STYLIST }))
    const { rows } = await pool.query(
      `select staff_user_id, to_char(starts_at, 'HH24:MI') s, to_char(ends_at, 'HH24:MI') e,
              status, duration_minutes, price, currency from bookings where id = $1`, [id])
    expect(rows[0]).toMatchObject({
      staff_user_id: STYLIST, s: '10:00', e: '11:00', status: 'pending',
      duration_minutes: 60, price: '150000', currency: 'IDR',
    })
  })

  it('snapshots the terms as they were, not as they later become', async () => {
    const id = await createBooking(args({ staffUserId: STYLIST }))
    await pool.query(`update services set price = 999000, duration_minutes = 30
                       where id = $1`, [SERVICE])
    const { rows } = await pool.query(
      `select price, duration_minutes, to_char(ends_at, 'HH24:MI') e
         from bookings where id = $1`, [id])
    expect(rows[0]).toMatchObject({ price: '150000', duration_minutes: 60, e: '11:00' })
  })

  it('refuses a start the slot list does not offer', async () => {
    // 10:15 is off a 30-minute grid; the client can post it, the server will
    // not take it.
    await expect(createBooking(args({ staffUserId: STYLIST, startsAt: `${DAY}T10:15` })))
      .rejects.toThrow('SLOT_TAKEN')
  })

  it('refuses a start already taken', async () => {
    await createBooking(args({ staffUserId: STYLIST }))
    await expect(createBooking(args({ staffUserId: STYLIST })))
      .rejects.toThrow('SLOT_TAKEN')
  })

  it('refuses a stylist who is not free then, rather than booking someone else', async () => {
    await linkStylists(STYLIST, OTHER_STYLIST)
    await createBooking(args({ staffUserId: STYLIST }))
    await expect(createBooking(args({ staffUserId: STYLIST })))
      .rejects.toThrow('SLOT_TAKEN')
    const { rows } = await pool.query(`select count(*)::int n from bookings
                                        where organization_id = $1`, [ORG])
    expect(rows[0].n, 'the failed attempt must not have booked the colleague').toBe(1)
  })

  it('refuses a service the branch does not offer', async () => {
    await pool.query(`
      insert into service_branch_overrides (service_id, team_id, organization_id, offered)
      values ($1, $2, $3, false)`, [SERVICE, TEAM, ORG])
    await expect(createBooking(args({ staffUserId: STYLIST }))).rejects.toThrow('SLOT_TAKEN')
  })

  it('assigns "any available" to the least-booked stylist', async () => {
    await linkStylists(STYLIST, OTHER_STYLIST)
    // Give STYLIST a booking earlier in the day, so OTHER_STYLIST is lighter.
    await book({ at: '09:00', until: '10:00', staff: STYLIST })
    const id = await createBooking(args({ staffUserId: null }))
    const { rows } = await pool.query(`select staff_user_id from bookings where id = $1`, [id])
    expect(rows[0].staff_user_id).toBe(OTHER_STYLIST)
  })

  it('lets a losing "any available" fall through to the colleague, not report a full salon', async () => {
    // The assertion the retry loop exists for, made DETERMINISTIC rather than
    // hoped for: firing two createBooking calls at once does NOT reliably
    // collide -- their queries interleave so the second usually reads the
    // first's booking and picks the colleague without ever retrying. Removing
    // the retry entirely still passed that version, so it proved nothing.
    //
    // Here an UNCOMMITTED insert on another connection holds the slot. It is
    // invisible to createBooking's recheck, so it picks the same stylist and
    // then BLOCKS on the exclusion constraint -- exactly the window between
    // recheck and write. Committing turns that block into 23P01, and only the
    // retry saves the booking.
    await linkStylists(STYLIST, OTHER_STYLIST)
    const holder = await pool.connect()
    let booked: string
    try {
      await holder.query('begin')
      await holder.query(
        `insert into bookings (id, organization_id, team_id, staff_user_id, customer_id,
                               service_id, starts_at, ends_at, status,
                               duration_minutes, price, currency)
         values ('bkg_holder', $1, $2, $3, $4, $5, $6::timestamp, $7::timestamp,
                 'pending', 60, 150000, 'IDR')`,
        [ORG, TEAM, STYLIST, CUSTOMER, SERVICE, `${DAY} 10:00`, `${DAY} 11:00`])

      const pending = createBooking(args({ staffUserId: null }))
      // Polled, not slept: wait until a backend is genuinely blocked on a lock.
      for (let i = 0; i < 200; i++) {
        const { rows } = await pool.query(
          `select count(*)::int n from pg_stat_activity
            where wait_event_type = 'Lock' and state = 'active'`)
        if (rows[0].n > 0) break
        await new Promise((r) => setTimeout(r, 25))
      }
      await holder.query('commit')
      booked = await pending
    } finally {
      holder.release()
    }
    const { rows } = await pool.query(
      `select staff_user_id from bookings where id = $1`, [booked])
    expect(rows[0].staff_user_id,
      'the loser must fall through to the free colleague').toBe(OTHER_STYLIST)
  })

  it('refuses a third "any available" when only two stylists are free', async () => {
    await linkStylists(STYLIST, OTHER_STYLIST)
    await createBooking(args({ staffUserId: null }))
    await createBooking(args({ staffUserId: null }))
    await expect(createBooking(args({ staffUserId: null }))).rejects.toThrow('SLOT_TAKEN')
  })
})

describe('the walk-in bypass', () => {
  // A date that has definitively passed, so "in the past" needs no clock
  // arithmetic. 2020-09-09 is a Wednesday, so the weekly pattern applies and
  // available_slots fills the day.
  const PAST = '2020-09-09'
  const q = { organizationId: ORG, teamId: TEAM, serviceId: SERVICE, date: PAST }

  it('keeps starts the normal path drops', async () => {
    expect(await listSlots(q), 'the default refuses the past').toEqual([])
    expect(await listSlots({ ...q, includePast: true }),
      'the walk-in path does not').not.toEqual([])
  })

  it('books confirmed, not pending -- there is nobody left to confirm it to', async () => {
    const slots = await listSlots({ ...q, includePast: true })
    const id = await createBooking({
      organizationId: ORG, teamId: TEAM, serviceId: SERVICE, customerId: CUSTOMER,
      date: PAST, startsAt: slots[0].startsAt, staffUserId: STYLIST,
      includePast: true, status: 'confirmed',
    })
    const { rows } = await pool.query(`select status from bookings where id = $1`, [id])
    expect(rows[0].status).toBe('confirmed')
  })

  it('still refuses a past start WITHOUT the bypass, so the default is not merely unused', async () => {
    await expect(createBooking({
      organizationId: ORG, teamId: TEAM, serviceId: SERVICE, customerId: CUSTOMER,
      date: PAST, startsAt: `${PAST}T10:00`, staffUserId: STYLIST,
    })).rejects.toThrow('SLOT_TAKEN')
  })

  it('still obeys the double-booking constraint -- the bypass is about time, not overlap', async () => {
    await createBooking({
      organizationId: ORG, teamId: TEAM, serviceId: SERVICE, customerId: CUSTOMER,
      date: PAST, startsAt: `${PAST}T10:00`, staffUserId: STYLIST,
      includePast: true, status: 'confirmed',
    })
    await expect(createBooking({
      organizationId: ORG, teamId: TEAM, serviceId: SERVICE, customerId: CUSTOMER,
      date: PAST, startsAt: `${PAST}T10:00`, staffUserId: STYLIST,
      includePast: true, status: 'confirmed',
    })).rejects.toThrow('SLOT_TAKEN')
  })
})

describe('listBookings', () => {
  it('returns the branch day in time order, with the names a list renders', async () => {
    await createBooking({
      organizationId: ORG, teamId: TEAM, serviceId: SERVICE, customerId: CUSTOMER,
      date: DAY, startsAt: `${DAY}T14:00`, staffUserId: STYLIST,
    })
    await createBooking({
      organizationId: ORG, teamId: TEAM, serviceId: SERVICE, customerId: CUSTOMER,
      date: DAY, startsAt: `${DAY}T10:00`, staffUserId: STYLIST,
    })
    const day = await listBookings(ORG, TEAM, DAY)
    expect(day.map((b) => b.startsAt)).toEqual([`${DAY}T10:00`, `${DAY}T14:00`])
    expect(day[0]).toMatchObject({
      staffUserId: STYLIST, customerName: 'Pelanggan', serviceName: 'Potong',
      status: 'pending', price: 150000, currency: 'IDR',
    })
  })

  it('does not show another salon its bookings, or another branch its day', async () => {
    await createBooking({
      organizationId: ORG, teamId: TEAM, serviceId: SERVICE, customerId: CUSTOMER,
      date: DAY, startsAt: `${DAY}T10:00`, staffUserId: STYLIST,
    })
    expect(await listBookings(ORG2, TEAM, DAY)).toEqual([])
    expect(await listBookings(ORG, TEAM2, DAY)).toEqual([])
  })
})

describe('rescheduleBooking', () => {
  const make = (at = '10:00', staff = STYLIST) => createBooking({
    organizationId: ORG, teamId: TEAM, serviceId: SERVICE, customerId: CUSTOMER,
    date: DAY, startsAt: `${DAY}T${at}`, staffUserId: staff,
  })
  const rowOf = async (id: string) => (await pool.query(
    `select to_char(starts_at, 'HH24:MI') s, to_char(ends_at, 'HH24:MI') e,
            staff_user_id, status, duration_minutes, price
       from bookings where id = $1`, [id])).rows[0]

  it('moves to a nearby time WITHOUT colliding with itself', async () => {
    // The whole reason available_slots grew p_exclude_booking_id: a 60-minute
    // booking at 10:00 overlaps 10:30, so without the exclusion its own row
    // makes every nearby slot read as taken.
    const id = await make('10:00')
    await rescheduleBooking(id, ORG, { startsAt: `${DAY}T10:30` })
    expect(await rowOf(id)).toMatchObject({ s: '10:30', e: '11:30' })
  })

  it('keeps the id, the status and the agreed terms', async () => {
    const id = await make('10:00')
    await pool.query(`update bookings set status = 'confirmed' where id = $1`, [id])
    await pool.query(`update services set duration_minutes = 90, price = 999000
                       where id = $1`, [SERVICE])

    await rescheduleBooking(id, ORG, { startsAt: `${DAY}T14:00` })
    const row = await rowOf(id)
    // ends_at is recomputed from the STORED duration, not the service's
    // current one -- a service that grew to 90 minutes must not silently
    // lengthen an appointment agreed at 60 (engine spec 2.5).
    expect(row).toMatchObject({
      s: '14:00', e: '15:00', duration_minutes: 60, price: '150000',
      status: 'confirmed',
    })
  })

  it('moves to a different stylist', async () => {
    await linkStylists(STYLIST, OTHER_STYLIST)
    const id = await make('10:00')
    await rescheduleBooking(id, ORG, { startsAt: `${DAY}T10:00`, staffUserId: OTHER_STYLIST })
    expect((await rowOf(id)).staff_user_id).toBe(OTHER_STYLIST)
  })

  it('releases the time it left', async () => {
    const id = await make('10:00')
    await rescheduleBooking(id, ORG, { startsAt: `${DAY}T14:00` })
    expect(await slots(STYLIST)).toContain('10:00')
  })

  it('refuses a time another booking already holds', async () => {
    await make('10:00')
    const second = await make('14:00')
    await expect(rescheduleBooking(second, ORG, { startsAt: `${DAY}T10:00` }))
      .rejects.toThrow('SLOT_TAKEN')
    expect((await rowOf(second)).s, 'and leaves it where it was').toBe('14:00')
  })

  it('refuses a time off the grid, or outside working hours', async () => {
    const id = await make('10:00')
    await expect(rescheduleBooking(id, ORG, { startsAt: `${DAY}T10:15` }))
      .rejects.toThrow('SLOT_TAKEN')
    await expect(rescheduleBooking(id, ORG, { startsAt: `${DAY}T23:00` }))
      .rejects.toThrow('SLOT_TAKEN')
  })

  it('refuses to move history -- completed, cancelled and no-show', async () => {
    for (const status of ['completed', 'cancelled', 'no_show'] as const) {
      await pool.query(`delete from bookings where organization_id = $1`, [ORG])
      const id = await make('10:00')
      await pool.query(`update bookings set status = $2 where id = $1`, [id, status])
      await expect(rescheduleBooking(id, ORG, { startsAt: `${DAY}T14:00` }), status)
        .rejects.toThrow('BAD_TRANSITION')
    }
  })

  it('cannot reach a booking in another salon', async () => {
    const id = await make('10:00')
    await expect(rescheduleBooking(id, ORG2, { startsAt: `${DAY}T14:00` }))
      .rejects.toThrow('NOT_FOUND')
  })
})

describe('setBookingStatus', () => {
  it('walks pending -> confirmed -> completed', async () => {
    const id = await createBooking({
      organizationId: ORG, teamId: TEAM, serviceId: SERVICE, customerId: CUSTOMER,
      date: DAY, startsAt: `${DAY}T10:00`, staffUserId: STYLIST,
    })
    await setBookingStatus(id, ORG, 'confirmed')
    await setBookingStatus(id, ORG, 'completed')
    const { rows } = await pool.query(`select status from bookings where id = $1`, [id])
    expect(rows[0].status).toBe('completed')
  })

  it('refuses a transition the lifecycle does not allow', async () => {
    const id = await createBooking({
      organizationId: ORG, teamId: TEAM, serviceId: SERVICE, customerId: CUSTOMER,
      date: DAY, startsAt: `${DAY}T10:00`, staffUserId: STYLIST,
    })
    // pending -> completed skips confirmation.
    await expect(setBookingStatus(id, ORG, 'completed')).rejects.toThrow('BAD_TRANSITION')
    await setBookingStatus(id, ORG, 'cancelled')
    // ...and a terminal status is terminal.
    await expect(setBookingStatus(id, ORG, 'confirmed')).rejects.toThrow('BAD_TRANSITION')
  })

  it('refuses a status outside the lifecycle at all', async () => {
    await expect(setBookingStatus('whatever', ORG, 'tentative')).rejects.toThrow('BAD_STATUS')
  })

  it('cannot reach a booking in another salon', async () => {
    const id = await createBooking({
      organizationId: ORG, teamId: TEAM, serviceId: SERVICE, customerId: CUSTOMER,
      date: DAY, startsAt: `${DAY}T10:00`, staffUserId: STYLIST,
    })
    await expect(setBookingStatus(id, ORG2, 'confirmed')).rejects.toThrow('BAD_TRANSITION')
  })
})

/**
 * Booking a slot queues its messages, and cancelling stops the ones that have
 * not gone (PRD §5.5). The queue's own behaviour is tests/notify.db.test.ts;
 * what these assert is that the real booking path is WIRED to it.
 */
describe('a booking queues its notifications', () => {
  // The fixture customer has no phone, so nothing is queued for them -- that
  // is asserted below rather than left as an accident of the fixture.
  const PHONED = 'bkg_phoned'

  beforeAll(async () => {
    await pool.query(`
      insert into customers (id, organization_id, name, phone, phone_key)
      values ($1, $2, 'Punya Nomor', '0813222', '62813222')
      on conflict (id) do nothing`, [PHONED, ORG])
  })

  const queued = async (bookingId: string) => (await pool.query(
    `select kind, status from notifications where booking_id = $1 order by kind`,
    [bookingId])).rows

  it('queues four messages when the booking is made', async () => {
    const id = await createBooking({
      organizationId: ORG, teamId: TEAM, serviceId: SERVICE, customerId: PHONED,
      date: DAY, startsAt: `${DAY}T13:00`, staffUserId: STYLIST,
    })
    const rows = await queued(id)
    expect(rows.map((r) => r.kind)).toEqual([
      'booking_confirmed', 'reminder_2h', 'reminder_day_before', 'thank_you',
    ])
    expect(rows.every((r) => r.status === 'queued')).toBe(true)
  })

  it('queues nothing for a customer with no number', async () => {
    const id = await createBooking({
      organizationId: ORG, teamId: TEAM, serviceId: SERVICE, customerId: CUSTOMER,
      date: DAY, startsAt: `${DAY}T14:00`, staffUserId: STYLIST,
    })
    expect(await queued(id)).toHaveLength(0)
  })

  it('cancelling the booking cancels the messages', async () => {
    const id = await createBooking({
      organizationId: ORG, teamId: TEAM, serviceId: SERVICE, customerId: PHONED,
      date: DAY, startsAt: `${DAY}T15:00`, staffUserId: STYLIST,
    })
    await setBookingStatus(id, ORG, 'cancelled')
    const rows = await queued(id)
    // The length first: `every` on an empty array is true, so the status
    // assertion alone would pass just as well if nothing had been queued.
    expect(rows).toHaveLength(4)
    expect(rows.every((r) => r.status === 'cancelled')).toBe(true)
  })

  it('a no-show cancels them too', async () => {
    const id = await createBooking({
      organizationId: ORG, teamId: TEAM, serviceId: SERVICE, customerId: PHONED,
      date: DAY, startsAt: `${DAY}T16:00`, staffUserId: STYLIST,
    })
    await setBookingStatus(id, ORG, 'confirmed')
    await setBookingStatus(id, ORG, 'no_show')
    const rows = await queued(id)
    expect(rows).toHaveLength(4)
    expect(rows.every((r) => r.status === 'cancelled')).toBe(true)
  })

  it('completing it does NOT cancel the thank-you', async () => {
    const id = await createBooking({
      organizationId: ORG, teamId: TEAM, serviceId: SERVICE, customerId: PHONED,
      date: DAY, startsAt: `${DAY}T17:00`, staffUserId: STYLIST,
    })
    await setBookingStatus(id, ORG, 'confirmed')
    await setBookingStatus(id, ORG, 'completed')
    const thanks = (await queued(id)).find((r) => r.kind === 'thank_you')
    expect(thanks!.status).toBe('queued')
  })
})
