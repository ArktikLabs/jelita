import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from './db'

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

const setDuration = (minutes: number) => pool.query(
  `update services set duration_minutes = $2 where id = $1`, [SERVICE, minutes])

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
  await setDuration(60)
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
    await setDuration(90)
    const s = await slots()
    expect(s.at(-1)).toBe('19:30')
    expect(s).not.toContain('20:00')
  })

  it('offers nothing when the service is longer than the working day', async () => {
    await setDuration(24 * 60)
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
