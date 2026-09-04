# WhatsApp Notifications — Implementation Plan

**Spec:** `docs/superpowers/specs/2026-09-04-notifications-design.md`
**Date:** 2026-09-04

Four steps. Each ends green with break-and-restore evidence.

---

## Step 1 — migration, templates, and `lib/notify.ts`

Two tables, plus the seeding trigger so a new salon has working messages on day
one (the same shape `staff_hours` uses for a new hire — an unconfigured thing
that silently does nothing is a failure nobody sees).

`lib/notify.ts` already exists with a `Channel` type and a `.mail.log`
transport for auth email. **Extend it, do not start a second module**: one
notification concept, two channels.

New functions: `queueForBooking`, `processDue`, `cancelForBooking`, `render`.

⚠️ `render` is the one worth a pure test: placeholder substitution with an
unknown placeholder left visible (spec §3.1), and a template edited afterwards
not touching an already-rendered body (§2.1).

**Break evidence:** re-render at read time instead of storing; blank unknown
placeholders; queue three events instead of four; cancel sent messages too.

## Step 2 — wire the triggers

`createBooking` queues; `setBookingStatus` cancels on `cancelled`/`no_show`.

Inside the same transaction as the booking, so a failure leaves neither.

⚠️ The public booking page and the walk-in path both go through
`createBooking`, so both get messages for free. Check that a walk-in — already
standing at the counter — does not get a "see you tomorrow" for an appointment
that already happened. Its `send_at` is in the past, which §2.2 says is queued
rather than dropped; the CENTER shows it as due, and that is correct because a
thank-you for a walk-in is a real message.

## Step 3 — the Notification Center and the templates card

`/dashboard/notifications`, and a settings card for the four templates.

**Break evidence:** guard the Center with `template:update` and watch front
desk lose it; drop the `notification:['send']` check on the process action.

⚠️ Expect the template-guard break to fail nothing unless the fixture has a
front-desk user reaching the page. It must.

## Step 4 — seed, screenshot, merge

The demo seed makes ~200 bookings; each now queues four messages. Check the
Center is not unusable at that volume, and that the seed still finishes in
reasonable time — 800 extra rows through `queueForBooking` is the first thing
in this project to do per-booking work at seed scale.

Then: full suite, build, screenshot, merge.

---

## Known risks

**The seed's runtime.** Four inserts per booking across ~200 bookings, each
rendering a template. If it slows the seed materially, batch the insert rather
than looping — but measure first.

**`lib/notify.ts` is used by auth email.** Password reset and verification go
through it today. Extending the module must not change that path; the existing
`Transport` and the new `NotificationProvider` are different things and should
stay different.
