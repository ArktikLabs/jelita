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

afterAll(async () => {
  await pool.query(`delete from organizations where id = any($1)`, [[ORG, ORG2]])
  await pool.end()
})

beforeEach(async () => {
  await pool.query(`delete from bookings where organization_id = any($1)`, [[ORG, ORG2]])
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
