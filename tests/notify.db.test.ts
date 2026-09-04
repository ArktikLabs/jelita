import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from './db'
import { db } from '../lib/db'
import {
  cancelForBooking, processDue, queueForBooking, render,
} from '../lib/notify'

/**
 * The notification queue (PRD §5.5), against real Postgres.
 *
 * Bookings are inserted directly rather than through createBooking: this file
 * is about what happens to the MESSAGES, and driving the booking engine here
 * would make every failure ambiguous between the two.
 */
const pool = new Pool({ connectionString: TEST_DATABASE_URL })

const ORG = 'ntf_org'
const ORG2 = 'ntf_org2'
const TEAM = 'ntf_team'
const TEAM2 = 'ntf_team2'
const STAFF = 'ntf_staff'
const CUST = 'ntf_cust'
const NOPHONE = 'ntf_nophone'
const SERVICE = 'ntf_service'

/** A booking at a wall-clock time relative to now, in whole hours. */
const makeBooking = async (
  id: string, hoursFromNow: number,
  { customer = CUST, org = ORG, team = TEAM } = {},
) => {
  await pool.query(`
    insert into bookings (id, organization_id, team_id, staff_user_id, customer_id,
      service_id, starts_at, ends_at, duration_minutes, price, currency)
    values ($1, $2, $3, $4, $5, $6,
            localtimestamp + make_interval(hours => $7),
            localtimestamp + make_interval(hours => $7) + interval '60 minutes',
            60, 100000, 'IDR')`,
    [id, org, team, STAFF, customer, SERVICE, hoursFromNow])
}

/**
 * Delete rows the immutability trigger would refuse.
 *
 * Fixture teardown, and the ONLY thing allowed to do this: the trigger
 * refusing a delete is exactly what the last test in this file asserts, so
 * turning it off anywhere else would be turning off the assertion.
 */
const purge = async (text: string, params: unknown[] = []) => {
  await pool.query('alter table notifications disable trigger notifications_sent_immutable')
  try {
    await pool.query(text, params)
  } finally {
    await pool.query('alter table notifications enable trigger notifications_sent_immutable')
  }
}

const rowsFor = async (bookingId: string) => (await pool.query(
  `select kind, status, body, "to", send_at, sent_at, provider_ref
     from notifications where booking_id = $1 order by send_at`, [bookingId])).rows

beforeAll(async () => {
  await purge(`delete from organizations where id = any($1)`, [[ORG, ORG2]])
  await pool.query(`delete from users where id = any($1)`,
    [[STAFF, 'ntf_owner', 'ntf_owner2']])
  await pool.query(`
    insert into organizations (id, name, slug, created_at)
    values ($1, 'Salon Ntf', 'ntf-one', now()), ($2, 'Ntf Two', 'ntf-two', now())`,
    [ORG, ORG2])
  await pool.query(`
    insert into teams (id, name, organization_id, created_at)
    values ($1, 'Cabang Utama', $2, now()), ($3, 'Cabang Lain', $4, now())`,
    [TEAM, ORG, TEAM2, ORG2])
  // Every salon needs an owner (the ownerless-salon guard), and a booking's
  // staff must be a staff_profile -- seeded by trigger from the member row.
  for (const [org, id] of [[ORG, 'ntf_owner'], [ORG2, 'ntf_owner2']] as const) {
    await pool.query(`
      insert into users (id, name, email, email_verified, created_at, updated_at)
      values ($1, $1, $1 || '@ntf.local', true, now(), now())`, [id])
    await pool.query(`
      insert into members (id, user_id, organization_id, role, created_at)
      values ($1 || '_m', $1, $2, 'owner', now())`, [id, org])
  }
  await pool.query(`
    insert into users (id, name, email, email_verified, created_at, updated_at)
    values ($1, 'Rina', 'ntf@ntf.local', true, now(), now())`, [STAFF])
  await pool.query(`
    insert into members (id, user_id, organization_id, role, created_at)
    values ($1 || '_m', $1, $2, 'stylist', now())`, [STAFF, ORG])
  await pool.query(`update staff_profiles set team_id = $1
                     where user_id = $2 and organization_id = $3`, [TEAM, STAFF, ORG])
  await pool.query(`
    insert into customers (id, organization_id, name, phone, phone_key)
    values ($1, $2, 'Budi', '0812111', '62812111'),
           ($3, $2, 'Tanpa Nomor', null, null)`, [CUST, ORG, NOPHONE])
  await pool.query(`
    insert into services (id, organization_id, name, duration_minutes, price)
    values ($1, $2, 'Potong Rambut', 60, 100000)`, [SERVICE, ORG])
})

beforeEach(async () => {
  await purge(`delete from notifications where organization_id = any($1)`, [[ORG, ORG2]])
  await pool.query(`delete from bookings where organization_id = any($1)`, [[ORG, ORG2]])
  await pool.query(
    `update notification_templates set body = t.body from (values
       ('booking_confirmed', 'Halo {{customer}}, {{service}} bersama {{staff}} pada {{date}} {{time}} di {{salon}}.'),
       ('reminder_day_before', 'Besok {{date}} {{time}}, {{service}}.'),
       ('reminder_2h', 'Hari ini {{time}}.'),
       ('thank_you', 'Terima kasih {{customer}}.')
     ) as t(kind, body)
     where notification_templates.kind = t.kind and organization_id = $1`, [ORG])
})

afterAll(async () => {
  await purge(`delete from organizations where id = any($1)`, [[ORG, ORG2]])
  await pool.query(`delete from users where id = any($1)`,
    [[STAFF, 'ntf_owner', 'ntf_owner2']])
  await pool.end()
})

describe('render', () => {
  it('substitutes what it knows', () => {
    expect(render('Halo {{customer}} di {{salon}}.', { customer: 'Budi', salon: 'Ntf' }))
      .toBe('Halo Budi di Ntf.')
  })

  it('leaves an UNKNOWN placeholder visible rather than blanking it', () => {
    // A typo must read as "{{cusomer}}" in the Notification Center, not as a
    // message with a hole where a name belongs. Blanking it produces text that
    // looks deliverable and is not.
    expect(render('Halo {{cusomer}}.', { customer: 'Budi' })).toBe('Halo {{cusomer}}.')
  })

  it('does not substitute an empty string for a missing key', () => {
    expect(render('Halo {{customer}}.', {})).toBe('Halo {{customer}}.')
  })
})

describe('queueForBooking', () => {
  it('queues all four messages, each due at its own time', async () => {
    await makeBooking('ntf_b1', 48)
    expect(await queueForBooking(db, ORG, 'ntf_b1')).toBe(4)

    const rows = await rowsFor('ntf_b1')
    expect(rows.map((r) => r.kind)).toEqual([
      'booking_confirmed', 'reminder_day_before', 'reminder_2h', 'thank_you',
    ])
    expect(rows.every((r) => r.status === 'queued')).toBe(true)

    // The ORDER above is the assertion that each send_at is distinct and
    // correctly placed: confirmation now, then a day before the 48h booking,
    // then two hours before it, then after it ends.
    const [confirm, dayBefore, twoHours, thanks] = rows.map((r) => new Date(r.send_at).getTime())
    const hour = 3600_000
    expect((dayBefore - confirm) / hour).toBeCloseTo(24, 1)
    expect((twoHours - confirm) / hour).toBeCloseTo(46, 1)
    expect((thanks - confirm) / hour).toBeCloseTo(49, 1)
  })

  it('renders the message from the template and stores the text', async () => {
    await makeBooking('ntf_b2', 24)
    await queueForBooking(db, ORG, 'ntf_b2')
    const [confirm] = await rowsFor('ntf_b2')
    expect(confirm.body).toContain('Halo Budi')
    expect(confirm.body).toContain('Potong Rambut bersama Rina')
    expect(confirm.body).toContain('di Salon Ntf.')
    expect(confirm.body).not.toContain('{{')
    expect(confirm.to).toBe('0812111')
  })

  it('editing a template does NOT rewrite a message already queued', async () => {
    await makeBooking('ntf_b3', 24)
    await queueForBooking(db, ORG, 'ntf_b3')
    const before = (await rowsFor('ntf_b3'))[0].body

    await pool.query(
      `update notification_templates set body = 'DIUBAH {{customer}}'
        where organization_id = $1 and kind = 'booking_confirmed'`, [ORG])

    // The stored body is a SNAPSHOT. The Center must show what would be sent,
    // and one of these may already have gone out.
    expect((await rowsFor('ntf_b3'))[0].body).toBe(before)

    // ...but the NEXT booking gets the new wording.
    await makeBooking('ntf_b4', 26)
    await queueForBooking(db, ORG, 'ntf_b4')
    expect((await rowsFor('ntf_b4'))[0].body).toBe('DIUBAH Budi')
  })

  it('queues nothing for a customer with no phone number', async () => {
    await makeBooking('ntf_b5', 24, { customer: NOPHONE })
    expect(await queueForBooking(db, ORG, 'ntf_b5')).toBe(0)
    expect(await rowsFor('ntf_b5')).toHaveLength(0)
  })

  it('queues a booking in the PAST anyway, due immediately', async () => {
    // A walk-in booked for the hour just gone still earns a thank-you.
    await makeBooking('ntf_b6', -1)
    expect(await queueForBooking(db, ORG, 'ntf_b6')).toBe(4)
    const due = await pool.query(
      `select count(*)::int n from notifications
        where booking_id = 'ntf_b6' and send_at <= localtimestamp`)
    expect(due.rows[0].n).toBe(4)
  })

  it('cannot queue the same event twice for one booking', async () => {
    await makeBooking('ntf_b7', 24)
    await queueForBooking(db, ORG, 'ntf_b7')
    expect(await queueForBooking(db, ORG, 'ntf_b7')).toBe(0)
    expect(await rowsFor('ntf_b7')).toHaveLength(4)
  })

  it('will not queue for a booking belonging to another salon', async () => {
    await makeBooking('ntf_b8', 24)
    expect(await queueForBooking(db, ORG2, 'ntf_b8')).toBe(0)
  })
})

describe('processDue', () => {
  it('sends only what has come due', async () => {
    await makeBooking('ntf_p1', 48)
    await queueForBooking(db, ORG, 'ntf_p1')

    // Only the confirmation is due for a booking two days out.
    expect(await processDue(ORG)).toBe(1)
    const rows = await rowsFor('ntf_p1')
    const sent = rows.filter((r) => r.status === 'sent')
    expect(sent).toHaveLength(1)
    expect(sent[0].kind).toBe('booking_confirmed')
    expect(sent[0].sent_at).not.toBeNull()
    expect(sent[0].provider_ref).toMatch(/^log:/)
    expect(rows.filter((r) => r.status === 'queued')).toHaveLength(3)
  })

  it('sends everything for a booking already in the past', async () => {
    await makeBooking('ntf_p2', -1)
    await queueForBooking(db, ORG, 'ntf_p2')
    expect(await processDue(ORG)).toBe(4)
  })

  it('is idempotent -- a second press sends nothing again', async () => {
    await makeBooking('ntf_p3', 48)
    await queueForBooking(db, ORG, 'ntf_p3')
    await processDue(ORG)
    expect(await processDue(ORG)).toBe(0)
  })

  it('with no salon named, sends across ALL of them -- the cron"s case', async () => {
    await makeBooking('ntf_p5', -1)
    await queueForBooking(db, ORG, 'ntf_p5')
    // Scoped to ORG2 it must send nothing; unscoped it must send these.
    expect(await processDue(ORG2)).toBe(0)
    expect(await processDue()).toBe(4)
  })

  it('does not send another salon"s messages', async () => {
    await makeBooking('ntf_p4', -1)
    await queueForBooking(db, ORG, 'ntf_p4')
    expect(await processDue(ORG2)).toBe(0)
    expect((await rowsFor('ntf_p4')).every((r) => r.status === 'queued')).toBe(true)
  })
})

describe('cancelForBooking', () => {
  it('cancels what has not gone out and leaves what has', async () => {
    await makeBooking('ntf_c1', 48)
    await queueForBooking(db, ORG, 'ntf_c1')
    await processDue(ORG) // the confirmation goes

    expect(await cancelForBooking(db, ORG, 'ntf_c1')).toBe(3)
    const rows = await rowsFor('ntf_c1')
    // The confirmation was SENT. It happened; a cancelled booking does not
    // rewrite the history of a message the customer already has.
    expect(rows.find((r) => r.kind === 'booking_confirmed')!.status).toBe('sent')
    expect(rows.filter((r) => r.status === 'cancelled')).toHaveLength(3)
  })

  it('a cancelled message is never sent afterwards', async () => {
    await makeBooking('ntf_c2', -1)
    await queueForBooking(db, ORG, 'ntf_c2')
    await cancelForBooking(db, ORG, 'ntf_c2')
    expect(await processDue(ORG)).toBe(0)
  })
})

describe('a sent message is immutable', () => {
  it('cannot be edited', async () => {
    await makeBooking('ntf_i1', -1)
    await queueForBooking(db, ORG, 'ntf_i1')
    await processDue(ORG)
    await expect(pool.query(
      `update notifications set body = 'diubah' where booking_id = 'ntf_i1'`))
      .rejects.toThrow(/cannot be changed/)
  })

  it('cannot be deleted', async () => {
    await makeBooking('ntf_i2', -1)
    await queueForBooking(db, ORG, 'ntf_i2')
    await processDue(ORG)
    await expect(pool.query(`delete from notifications where booking_id = 'ntf_i2'`))
      .rejects.toThrow(/cannot be deleted/)
  })
})
