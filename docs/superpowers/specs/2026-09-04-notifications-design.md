# WhatsApp Notifications — Design

**Date:** 2026-09-04
**Status:** draft
**Covers:** PRD §5.5 (P2, simulated in MVP)

## 1. Goal

§5.5's demo talking point, verbatim: *"This is the actual message pipeline —
going live is a credentials swap, not a rebuild."*

That sentence is the requirement. It is only true if the pipeline is real:
messages are queued, rendered, transitioned and recorded exactly as they would
be in production, and the **only** thing missing is a provider with
credentials.

### In scope

- `notifications` — a queue with real states (`queued` → `sent`)
- Templates per event, editable by admin, with placeholders
- The four §5.5 triggers, queued when a booking is made
- A Notification Center showing the exact message that would be sent
- A `NotificationProvider` seam with a simulator as the only implementation

### Out of scope

- **A real provider.** §5.5 says simulated by name. Fonnte, Wablas and the Meta
  API all need credentials and a business verification this project does not
  have.
- **A scheduler.** See §2.4 — the one honestly missing piece, named rather than
  faked.
- **Inbound messages.** §5.5 is one-way.

## 2. Decisions

### 2.1 The message is rendered when it is QUEUED, and stored

§5.5 asks the Notification Center to show "the exact message that *would* be
sent". That is only exact if it is the text itself, not a template re-rendered
at view time against data that has since changed.

So the rendered body is a snapshot, like a line's price and a booking's
duration. An admin editing a template does not rewrite messages already
queued — and must not, because one of them may already have been sent.

### 2.2 Four messages are queued when the booking is made

| Event | `send_at` |
|---|---|
| confirmation | immediately |
| the day before | `starts_at − 1 day` |
| two hours before | `starts_at − 2 hours` |
| thank you | `ends_at` |

All four at once, because the schedule is knowable then and a queue whose rows
appear later needs something to make them appear — which is the scheduler this
slice does not have.

A `send_at` in the past is queued anyway rather than skipped: a booking made
for this afternoon should still show its reminders as due, and dropping them
silently would make the Center lie about what the pipeline would do.

### 2.3 Cancelling a booking cancels its unsent messages

A cancelled appointment must not still send "see you tomorrow". Unsent rows
move to `cancelled`; **sent ones are left alone**, because they were sent — the
history of what happened includes messages that turned out to be premature.

Same for a no-show: the thank-you is cancelled if it has not gone.

### 2.4 The scheduler is a button, and that is stated

`send_at` is real, the states are real, and a **"process due"** action moves
every queued message whose time has come to `sent`. Production replaces that
action's trigger with a cron; nothing else changes.

**ponytail: due messages are processed by a button, not a scheduler.** Ceiling:
nothing sends on its own, so a demo has to press it. Upgrade path: a cron
hitting the same code path — which is why processing lives in `lib/notify.ts`
and not inside the Server Action.

Said plainly here so nobody demos it as automatic.

### 2.5 One message per booking per event

`unique (booking_id, kind)`. Queuing twice is not a thing, and a constraint
says so rather than a check somebody remembers — the same shape
`commissions_one_per_line` uses.

### 2.6 A sent message is immutable

It follows the rule the rest of this product uses for things that have
happened: editable while `queued`, refused after. A record of what was sent
that can be edited afterwards is not a record.

### 2.7 The provider seam is one function

```
send(message) -> { status: 'sent' | 'failed', provider, ref? }
```

`SimulatedWhatsApp` answers `sent` with a fake reference. A real provider
answers the same shape from an HTTP call. Mirrors `PaymentProvider`, and for
the same reason: the seam that must be real is *where it plugs in and what it
records*.

What a real provider would additionally need, stated rather than implied: a
`failed` path that retries, and delivery receipts arriving asynchronously.
Neither is built, and neither is what "credentials swap" is claiming.

## 3. Data model

### 3.1 `notification_templates`

`organization_id`, `kind`, `body`. Primary key on the pair; seeded per salon by
trigger so a new salon has working messages on day one.

Placeholders are `{{customer}}`, `{{salon}}`, `{{branch}}`, `{{service}}`,
`{{staff}}`, `{{date}}`, `{{time}}` — substituted at queue time. An unknown
placeholder is left as written rather than blanked, so a typo is visible in the
Center instead of producing a message with a hole in it.

### 3.2 `notifications`

`id`, `organization_id`, `team_id`, `booking_id`, `customer_id`, `kind`,
`channel`, `to`, `body`, `status`, `send_at`, `sent_at`, `provider`,
`provider_ref`, `created_at`.

Composite foreign keys throughout. `to` and `body` are snapshots.

## 4. Screens

- **`/dashboard/notifications`** — the Center: due first, then queued, then
  sent. Each row shows the recipient, the event, the time it is due, and the
  message itself. A "process due" button for anyone holding
  `notification:['send']`.
- The four templates, for `notification:['template:update']` (owner and admin;
  front desk holds `read` and `send` but not this).

  **Built on the notifications page, not in settings** as this section first
  said: one page instead of two, and the message and the template it came from
  sit next to each other, which is what an owner is comparing when they edit
  one. The permission gate is the same either way.

## 5. Testing

Vitest against real Postgres:

1. Making a booking queues four messages, with the right `send_at` for each.
2. The body is rendered from the template with placeholders substituted.
3. Editing a template does not change an already-queued message.
4. An unknown placeholder is left visible rather than blanked.
5. Processing due messages sends only those whose time has come.
6. Cancelling a booking cancels unsent messages and leaves sent ones alone.
7. A booking cannot queue the same event twice.
8. A sent message cannot be edited or deleted.
9. Everything is scoped to the salon and the branch.

Playwright:

10. The Center lists the queued messages for a new booking, showing the text.
11. Processing due moves them to sent, and the count changes.
12. Front desk may process but not edit templates; a stylist reaches neither.
13. Editing a template changes the NEXT booking's message and not the last.

**Every load-bearing assertion gets break-and-restore evidence.**

## 6. What the build found

**`send_at` is wall clock.** `bookings.starts_at` is `timestamp` without a
zone by design (booking spec §2.6), and three of the four `send_at` values
derive from it. A timestamptz here would have compared an appointment's wall
time against an instant.

**A value exported from a `'use client'` module reaches a server component as
a client reference, not the object.** `KIND_LABEL` lived in the forms file;
every lookup returned undefined and the event column rendered blank. Nothing
caught it -- not tsc, not the build, not a test. Screenshotting did.

**`every` on an empty array is true.** "All four messages are cancelled"
passed just as well when nothing had been queued. The count is asserted first
now, and breaking the queue call fails four tests instead of two.

**The seed backdates bookings, so its notifications need backdating too.**
Left alone, the Center opened on 849 overdue messages. Keyed on whether the
appointment has passed, not on `send_at` -- a confirmation's `send_at` is when
it was queued, which for a backdated booking is when the seed ran.
