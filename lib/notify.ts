import { appendFileSync } from 'node:fs'

export type Channel = 'email' | 'whatsapp' | 'telegram'
export type Message = {
  channel: Channel
  to: string
  subject?: string
  body: string
}
/** Returns the provider's reference for the sent message, for the record. */
type Transport = (m: Message) => Promise<string>

/**
 * Writes to .mail.log (gitignored) so password-reset, verification and
 * invitation links are greppable in dev instead of needing a real inbox.
 * scripts/ui-check.mjs reads this file to drive the end-to-end flows.
 */
const logTransport: Transport = async (m) => {
  const entry =
    `\n[${new Date().toISOString()}] channel=${m.channel} to=${m.to}`
    + `${m.subject ? ` subject="${m.subject}"` : ''}\n${m.body}\n`
  console.log(entry)
  try {
    appendFileSync('.mail.log', entry)
  } catch {
    // best effort: a read-only fs in prod is fine, console still has it
  }
  // A real provider answers with its own message id. Returning one here keeps
  // the recorded shape identical, so swapping in Fonnte changes the transport
  // and nothing that reads it.
  return `log:${crypto.randomUUID()}`
}

// One transport today. Wiring a real channel is: write the transport, swap the
// entry below. Nothing above this line changes. Deliberately no registry and no
// env branching — nothing registers anything, and a key check guarding a
// transport that does not exist is a branch guarding nothing.
const transports: Record<Channel, Transport> = {
  email: logTransport,
  whatsapp: logTransport,
  telegram: logTransport,
}

export const notify = (m: Message) => transports[m.channel](m)

// ---------------------------------------------------------------------------
// The queue (PRD §5.5). Messages are rendered when they are QUEUED and stored,
// because the Notification Center must show the exact text that would be sent
// -- see docs/superpowers/specs/2026-09-04-notifications-design.md.
// ---------------------------------------------------------------------------

import { sql } from 'drizzle-orm'
import { db } from './db'

export type NotificationKind =
  | 'booking_confirmed' | 'reminder_day_before' | 'reminder_2h' | 'thank_you'

/** Minimal shape of the db handle, so this works inside a caller's transaction. */
type Executor = { execute: (q: ReturnType<typeof sql>) => Promise<{ rows: unknown[] }> }

/**
 * Substitute {{placeholders}}.
 *
 * An UNKNOWN placeholder is left exactly as written rather than blanked. A
 * typo in a template should be visible in the Notification Center as
 * "{{cusomer}}", not as a message with a hole where a name belongs -- the
 * whole point of the Center is that somebody can read what would go out.
 */
export function render(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{(\w+)\}\}/g, (whole, key: string) =>
    Object.hasOwn(vars, key) ? vars[key] : whole)
}

/**
 * Queue every message a booking will send, at the moment it is made.
 *
 * All four at once, because the schedule is knowable now and a queue whose
 * rows appear later needs something to make them appear -- which is the
 * scheduler this MVP deliberately does not have (spec §2.4).
 *
 * A `send_at` already in the past is queued anyway. A walk-in booked for the
 * hour just gone still earns a thank-you, and silently dropping the rest would
 * make the Center lie about what the pipeline does.
 *
 * A customer with NO phone number queues nothing at all: WhatsApp needs a
 * number, and a row addressed to nobody is not a message. Same call
 * writePoints makes for a sale with no customer.
 */
export async function queueForBooking(
  tx: Executor, organizationId: string, bookingId: string,
): Promise<number> {
  const { rows } = await tx.execute(sql`
    select b.team_id, b.customer_id, c.phone, c.name as customer,
           o.name as salon, tm.name as branch,
           s.name as service, u.name as staff,
           to_char(b.starts_at, 'DD-MM-YYYY') as date,
           to_char(b.starts_at, 'HH24:MI') as time,
           to_char(localtimestamp, 'YYYY-MM-DD HH24:MI:SS') as at_booking_confirmed,
           to_char(b.starts_at - interval '1 day', 'YYYY-MM-DD HH24:MI:SS')
             as at_reminder_day_before,
           to_char(b.starts_at - interval '2 hours', 'YYYY-MM-DD HH24:MI:SS')
             as at_reminder_2h,
           to_char(b.ends_at, 'YYYY-MM-DD HH24:MI:SS') as at_thank_you
      from bookings b
      join customers c on c.id = b.customer_id
      join organizations o on o.id = b.organization_id
      join teams tm on tm.id = b.team_id
      join services s on s.id = b.service_id
      join users u on u.id = b.staff_user_id
     where b.id = ${bookingId} and b.organization_id = ${organizationId}`)
  const b = rows[0] as Record<string, string | null> | undefined
  if (!b || !b.phone) return 0

  const { rows: templates } = await tx.execute(sql`
    select kind, body from notification_templates
     where organization_id = ${organizationId}`)

  const vars: Record<string, string> = {
    customer: b.customer ?? '', salon: b.salon ?? '', branch: b.branch ?? '',
    service: b.service ?? '', staff: b.staff ?? '',
    date: b.date ?? '', time: b.time ?? '',
  }

  let queued = 0
  for (const t of templates as { kind: NotificationKind; body: string }[]) {
    const sendAt = b[`at_${t.kind}`]
    if (!sendAt) continue
    const { rows: written } = await tx.execute(sql`
      insert into notifications
        (id, organization_id, team_id, booking_id, customer_id, kind, "to", body, send_at)
      values (${crypto.randomUUID()}, ${organizationId}, ${b.team_id}, ${bookingId},
              ${b.customer_id}, ${t.kind}, ${b.phone}, ${render(t.body, vars)},
              ${sendAt}::timestamp)
      on conflict (booking_id, kind) do nothing
      returning id`)
    queued += written.length
  }
  return queued
}

/**
 * Cancel what a cancelled booking has not sent yet.
 *
 * SENT messages are left alone. They went out; the history of what happened
 * includes the ones that turned out to be premature, and the immutability
 * trigger would refuse to rewrite them anyway.
 */
export async function cancelForBooking(
  tx: Executor, organizationId: string, bookingId: string,
): Promise<number> {
  const { rows } = await tx.execute(sql`
    update notifications set status = 'cancelled'
     where booking_id = ${bookingId} and organization_id = ${organizationId}
       and status = 'queued'
    returning id`)
  return rows.length
}

/**
 * Send everything that has come due.
 *
 * ponytail: due messages are processed by a button, not a scheduler. The
 * ceiling is that nothing sends on its own -- a demo has to press it.
 * Upgrade path: a cron calling this exact function, which is why the work
 * lives here and not inside the Server Action.
 *
 * `for update skip locked` so two presses cannot send the same message twice.
 */
export async function processDue(organizationId: string): Promise<number> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.execute(sql`
      select id, channel, "to", body from notifications
       where organization_id = ${organizationId}
         and status = 'queued' and send_at <= localtimestamp
       order by send_at
       for update skip locked`)

    for (const r of rows as { id: string; channel: Channel; to: string; body: string }[]) {
      const ref = await notify({ channel: r.channel, to: r.to, body: r.body })
      await tx.execute(sql`
        update notifications
           set status = 'sent', sent_at = now(), provider = 'log', provider_ref = ${ref}
         where id = ${r.id}`)
    }
    return rows.length
  })
}
