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

/**
 * Real email, when a key exists.
 *
 * Resend because it needs an API key and nothing else -- no domain
 * verification to get started, no SMTP credentials to store.
 */
const resendTransport: Transport = async (m) => {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.MAIL_FROM ?? 'Jelita <onboarding@resend.dev>',
      to: m.to,
      subject: m.subject ?? 'Jelita',
      text: m.body,
    }),
  })
  if (!res.ok) throw new Error(`resend ${res.status}: ${await res.text()}`)
  return `resend:${((await res.json()) as { id?: string }).id ?? 'unknown'}`
}

// The log transport is the DEFAULT, not the leftover: tests/e2e/mail.ts reads
// .mail.log to drive the auth flows, so every test run needs it. A real key
// swaps email over and nothing else changes -- which is the whole claim the
// adapter is making.
const emailTransport = process.env.RESEND_API_KEY ? resendTransport : logTransport

const transports: Record<Channel, Transport> = {
  email: emailTransport,
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
  | 'password_reset' | 'email_verification' | 'invitation'

/**
 * Wording for a message with NO salon behind it -- a signup verification,
 * or a reset for someone who does not work anywhere yet. There is no
 * organization whose template could apply, so these are the fallback.
 *
 * Kept in step with the seeding trigger in db/migrations/0031 by hand. The
 * duplication is real; the alternative is a template row keyed on a null
 * organization, which the primary key cannot express.
 */
const DEFAULT_TEMPLATES: Partial<Record<NotificationKind, string>> = {
  password_reset:
    'Halo {{name}}, klik tautan berikut untuk mengatur ulang kata sandi Anda: {{link}}',
  email_verification:
    'Halo {{name}}, klik tautan berikut untuk memverifikasi email Anda: {{link}}',
  invitation:
    '{{inviter}} mengundang Anda bergabung di {{salon}}. Klik untuk menerima: {{link}}',
}

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
 * Driven by two callers: the Notification Center's button (scoped to one
 * salon) and the cron at /api/cron/notifications (every salon).
 *
 * `for update skip locked` so a press landing on top of a cron run -- or two
 * cron runs overlapping because one was slow -- cannot send the same message
 * twice. That is the property that makes running this on a timer safe.
 */
export async function processDue(
  organizationId: string | null = null,
): Promise<number> {
  return db.transaction(async (tx) => {
    // null means EVERY salon -- the cron's case. The Server Action always
    // passes its caller's organization, so one salon pressing the button can
    // never dispatch another's messages.
    const { rows } = await tx.execute(sql`
      select id, channel, "to", body from notifications
       where status = 'queued' and send_at <= localtimestamp
         ${organizationId ? sql`and organization_id = ${organizationId}` : sql``}
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

export type NotificationRow = {
  id: string
  kind: NotificationKind
  status: string
  to: string
  body: string
  customerName: string | null
  sendAt: string
  sentAt: string | null
  due: boolean
}

/**
 * The Notification Center's list (PRD §5.5): what would be sent, and whether
 * it has been.
 *
 * Ordered DUE first, then the rest of the queue, then what has already gone.
 * The due ones are the only rows anybody can act on, so they are the ones that
 * must not be below the fold.
 *
 * `status` narrows it, and the demo salon is why it has to exist: a hundred
 * queued reminders sit ahead of every sent message, so with a flat limit the
 * sent half -- auth email included -- was unreachable. A filter beats a bigger
 * limit; the page a person wants is small, it is just not the first hundred.
 */
export async function listNotifications(
  organizationId: string, teamId: string | null, status: string | null = null,
): Promise<NotificationRow[]> {
  const { rows } = await db.execute(sql`
    select n.id, n.kind, n.status, n."to", n.body, c.name as customer_name,
           (n.status = 'queued' and n.send_at <= localtimestamp) as due,
           to_char(n.send_at, 'YYYY-MM-DD HH24:MI') as send_at,
           to_char(n.sent_at, 'YYYY-MM-DD HH24:MI') as sent_at
      from notifications n
      left join customers c on c.id = n.customer_id
     where n.organization_id = ${organizationId}
       ${teamId ? sql`and (n.team_id = ${teamId} or n.team_id is null)` : sql``}
       ${status ? sql`and n.status = ${status}` : sql``}
     order by due desc,
              case n.status when 'queued' then 0 when 'failed' then 1
                            when 'sent' then 2 else 3 end,
              n.send_at desc
     limit 100`)
  return (rows as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    kind: r.kind as NotificationKind,
    status: r.status as string,
    to: r.to as string,
    body: r.body as string,
    customerName: (r.customer_name as string) ?? null,
    sendAt: r.send_at as string,
    sentAt: (r.sent_at as string) ?? null,
    due: r.due as boolean,
  }))
}

/** The four editable templates, in the order the events happen. */
export async function listTemplates(
  organizationId: string,
): Promise<{ kind: NotificationKind; body: string }[]> {
  const { rows } = await db.execute(sql`
    select kind, body from notification_templates
     where organization_id = ${organizationId}
     order by case kind when 'booking_confirmed' then 0
                        when 'reminder_day_before' then 1
                        when 'reminder_2h' then 2 else 3 end`)
  return rows as { kind: NotificationKind; body: string }[]
}

/**
 * Rewrite one template. Messages already queued keep the text they were
 * rendered with -- see queueForBooking.
 */
export async function setTemplate(
  organizationId: string, kind: string, body: string,
): Promise<void> {
  const { rows } = await db.execute(sql`
    update notification_templates set body = ${body}, updated_at = now()
     where organization_id = ${organizationId} and kind = ${kind}
    returning kind`)
  if (rows.length === 0) throw new Error('UNKNOWN_TEMPLATE')
}

/**
 * Send a transactional message NOW, and record what was sent.
 *
 * Auth email is not scheduled. A password reset that waits up to fifteen
 * minutes for the cron is broken, so these are dispatched in the call that
 * creates them and land as `sent`, never `queued`.
 *
 * ## The one rule this function exists to enforce
 *
 * `secret` is substituted into the message that GOES OUT and never into the
 * message that is STORED. The Notification Center displays the stored body,
 * and notification:['read'] reaches front desk -- so a stored reset URL would
 * let any front-desk login take the owner's account.
 *
 * That is why callers pass two maps instead of rendering the body themselves:
 * the split is not a convention anybody has to remember, it is the only shape
 * this function accepts. The stored copy keeps `{{link}}` written out, which
 * `render` leaves visible for exactly this reason.
 *
 * Dispatch happens BEFORE the row is written. The other order would leave a
 * `queued` row behind on a transport failure, and the cron would then send it
 * again -- a second reset link for a mail that already went.
 */
export async function sendNow(opts: {
  organizationId: string | null
  kind: NotificationKind
  to: string
  subject: string
  /** Substituted in both copies. */
  vars: Record<string, string>
  /** Substituted ONLY in the message that is sent. */
  secret: Record<string, string>
}): Promise<void> {
  let body = DEFAULT_TEMPLATES[opts.kind] ?? ''
  if (opts.organizationId) {
    const { rows } = await db.execute(sql`
      select body from notification_templates
       where organization_id = ${opts.organizationId} and kind = ${opts.kind}`)
    body = (rows[0] as { body?: string } | undefined)?.body ?? body
  }

  const stored = render(body, opts.vars)
  const sent = render(body, { ...opts.vars, ...opts.secret })

  const ref = await notify({
    channel: 'email', to: opts.to, subject: opts.subject, body: sent,
  })

  await db.execute(sql`
    insert into notifications
      (id, organization_id, team_id, kind, channel, "to", body,
       status, send_at, sent_at, provider, provider_ref)
    values (${crypto.randomUUID()}, ${opts.organizationId}, null, ${opts.kind},
            'email', ${opts.to}, ${stored}, 'sent', localtimestamp, now(),
            ${process.env.RESEND_API_KEY ? 'resend' : 'log'}, ${ref})`)
}

/**
 * The salon a person belongs to, or null.
 *
 * A password reset for someone who already works at a salon should appear in
 * that salon's Notification Center; a reset for a brand-new signup belongs to
 * nobody. `limit 1` because a member of two salons is not a case this product
 * has -- and picking the older membership is a better guess than failing.
 */
export async function organizationOf(userId: string): Promise<string | null> {
  const { rows } = await db.execute(sql`
    select organization_id from members
     where user_id = ${userId} order by created_at limit 1`)
  return (rows[0] as { organization_id?: string } | undefined)?.organization_id ?? null
}
