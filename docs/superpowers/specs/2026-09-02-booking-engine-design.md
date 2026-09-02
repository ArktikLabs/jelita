# Booking Engine — Design

**Date:** 2026-09-02
**Status:** draft
**Depends on:** staff scheduling (`staff_working_hours`), services catalogue
(`service_branch_pricing`, `service_staff`), customers (`findOrCreateByPhone`)

## 1. Goal

Turn "when is this stylist available?" into "book this customer with this
stylist for this service at this time, and never twice."

Availability is a query. **Booking is a guarantee**, and the guarantee is the
part worth spending the design on: two customers must not end up in the same
chair, and no amount of application-level checking gets there on its own.

### In scope

- `bookings` — the record, with an exclusion constraint that makes a
  double-booking unrepresentable
- `available_slots(...)` — candidate start times, in the database
- `slot_minutes` on the salon, and a `/dashboard/settings` screen to hold it
- An internal booking form and a day list at `/dashboard/bookings`
- The `/dashboard` route prefix (§2.1)

### Out of scope

- **The public booking page.** Next slice; this one publishes the engine and
  drives it from an internal form.
- **The calendar view and walk-ins.** Slice after that. See §9 for the one
  thing walk-ins will need back from here.
- **Customer accounts and loyalty.** See §2.7 — the design does not foreclose
  them, and builds nothing for them.
- **Reminders and notifications.** PRD §5.4, separate.

## 2. Decisions

### 2.1 Internal routes move under `/dashboard`

`app/dashboard/` becomes `app/dashboard/`. The group adds no URL segment today, so
`/staff` and `/services` sit at the root; after the rename they are
`/dashboard/staff` and `/dashboard/services`, and the overview page — already
named `dashboard` — keeps the URL it has.

This is namespace hygiene, not a security boundary: the guard is
`requirePageOrg` in the layout either way. What it buys is a **free root
namespace**, so a salon's public link can later be `/ovarya` rather than
`/book/ovarya` without every internal route name becoming a reserved word.
Nothing external points at these URLs yet, which will stop being true the
moment the demo is shown.

**Done as its own commit, before any booking code**, so the diff that adds
bookings is not buried in path edits.

### 2.2 A pending booking holds the slot

`pending` and `confirmed` both hold it; `cancelled` and `no_show` release it.
The alternative — pending as a soft hold that others can book over — means the
salon confirms a booking it cannot honour, which is the failure the whole
constraint exists to prevent.

`completed` does not need to hold anything: it is always in the past, and past
starts are dropped before slots are offered.

### 2.3 The slot grid is per salon, and editable at any time

`salon_profiles.slot_minutes`, default 30, constrained to
`{15, 20, 30, 45, 60}`. A salon running 45-minute appointments should not see a
30-minute grid, and hardcoding 30 is a demo that fails its first question.

Editing it later is safe because **a booking stores its own start and end**.
Changing the grid changes which slots are *offered* tomorrow; it cannot
invalidate what is already booked. That is the whole reason the grid is a
setting rather than a schema shape.

Starts align to the **working interval's opening time**, not to midnight: a
45-minute grid on a 09:00 open gives 09:00, 09:45, 10:30, which is what a
salon expects to read.

### 2.4 "Any available" is a first-class choice

The customer picks a named stylist or "any available". Named is the demo's
headline — people have a favourite — but forcing a choice loses the customer
who does not care and would otherwise have taken the 10:00.

"Any available" is not a stored value. It is a **fan-out at slot time** across
qualified stylists, and an **assignment at booking time** to the least-booked
of those free then. The booking row always names a real stylist.

### 2.5 The booking snapshots duration, price and currency

A service's price and duration change. A booking made last week was made at
last week's terms, and the receipt has to say so. The alternative is a POS that
silently re-prices history.

Snapshotting duration matters for a second reason: `ends_at` is stored, so a
service growing from 60 to 90 minutes does not retroactively overlap the
appointment after it — and therefore cannot break the exclusion constraint on
rows that were valid when written.

### 2.6 Times are local `timestamp`, not `timestamptz`

The salon and its customers are in one timezone, decided in branch management,
and `staff_working_hours` already returns bare `time`. A 14:00 appointment is
14:00 on the wall. Storing an instant would mean converting at every boundary
to display the number the salon actually cares about.

The cost is real and accepted: a salon in a second timezone needs a migration.
That is a business the product does not have.

### 2.7 One auth system; a customer is identified by phone

Staff and customers share the `user` table. The discriminator is **membership**,
not a column: a user with a `members` row is staff at that salon, a user linked
to a `customers` row is a customer there, and the same person can be both. Two
better-auth instances would mean two session cookies, two password-reset flows,
and two accounts for a stylist who gets her hair done elsewhere on the platform.

**The durable customer identity is the phone number**, exactly as `customers` is
keyed today. An account is an optional attachment, never a prerequisite —
so the public page can take a name and a phone and nothing else, and loyalty
later becomes an upgrade on history that already exists rather than a wall in
front of a first booking. Walk-ins entered by the front desk get the same
treatment.

Nothing is built for this now. See §9 for the two lines it will cost.

## 3. Data model

### 3.1 `salon_profiles.slot_minutes`

`smallint not null default 30`, check `slot_minutes in (15, 20, 30, 45, 60)`.
An allow-list rather than a range: 7-minute grids are a bug, not a business
model, and the check is what makes `generate_series` safe.

### 3.2 `bookings`

| column | notes |
|---|---|
| `id` | PK |
| `organization_id` | the salon |
| `team_id` | the branch, snapshotted — a stylist who transfers must not rewrite where past appointments happened |
| `staff_user_id` | always a real person, including for "any available" (§2.4) |
| `customer_id` | |
| `service_id` | |
| `starts_at`, `ends_at` | `timestamp`, local (§2.6) |
| `status` | `pending` / `confirmed` / `completed` / `cancelled` / `no_show` |
| `duration_minutes`, `price`, `currency` | snapshots (§2.5) |
| `note` | nullable |

Checks: `ends_at > starts_at`; `status` in the five values.

Index on `(organization_id, team_id, starts_at)` — the day list's only query.

### 3.3 The guarantee

```sql
create extension if not exists btree_gist;

alter table bookings add constraint bookings_no_overlap
  exclude using gist (
    staff_user_id with =,
    tsrange(starts_at, ends_at, '[)') with &&
  ) where (status in ('pending', 'confirmed'));
```

`btree_gist` is what lets the plain equality on `staff_user_id` sit in a GiST
index alongside the range. `'[)'` bounds are load-bearing: a 10:00–11:00 and an
11:00–12:00 appointment share an endpoint and must not collide.

The partial `where` is what makes cancelling release the slot (§2.2).

**Time off is deliberately outside this constraint.** Blocks live in
`staff_time_off` per the scheduling spec §2.2, and are applied as a filter in
`available_slots` alongside existing bookings — one filter, because a block and
an appointment are the same kind of busy period. Putting them in the same table
to share the constraint would mean a block carrying a customer, a service and a
price it does not have.

The consequence is honest and accepted: the database prevents two bookings
overlapping, but only `available_slots` prevents a booking landing on time off.
§5 is written so that gap is never reachable through the app.

### 3.4 Cross-tenant rows are unrepresentable

Composite foreign keys, as everywhere else here:

- `(organization_id, customer_id)` → `customers_org_id`
- `(organization_id, service_id)` → `services_org_id`
- `(staff_user_id, organization_id)` → `staff_profiles_one_branch`
- `(team_id, organization_id)` → `teams_id_organization_id_unique`

All four unique constraints already exist. RLS enabled with zero policies, like
every other table.

## 4. Availability

```
available_slots(p_organization_id text, p_team_id text, p_service_id text,
                p_date date, p_staff_user_id text default null)
  returns table (starts_at timestamp, staff_user_id text)
```

In SQL for the reason `staff_working_hours` and `service_branch_pricing` are:
the booking path and the check suite exercise **the same logic**, rather than
the tests re-implementing it and proving only that the copy works.

One row per bookable start per stylist. A candidate survives when:

1. The service is **offered at that branch** — `service_branch_pricing.offered`,
   which already folds in the service's own `active` flag. Not offered → no
   rows at all.
2. The stylist is linked to the service (`service_staff`), assigned to that
   branch, and active. Narrowed to one when `p_staff_user_id` is given.
3. `staff_working_hours(stylist, org, p_date)` returns an interval.
   **The function iterates the set** — scheduling spec §2.4 is binding, and
   this is the caller it was written for.
4. Starts step by `slot_minutes` from the interval's opening time (§2.3).
5. `start + duration <= interval end` — the service fits **entirely**. A
   90-minute service simply stops being offered after 19:30 on a 21:00 close.
6. `[start, start + duration)` overlaps no `pending`/`confirmed` booking for
   that stylist and no `staff_time_off` block — one filter, two sources.

Deliberately **not** in the function: dropping starts in the past. That lives in
`lib/booking.ts` (§5), the single module both callers route through, so the
function stays pure over its arguments and trivially testable, and neither
caller can forget it.

"Any available" is the **distinct starts** of that result. The stylist is chosen
at booking time, not slot time.

## 5. Creating a booking

`lib/booking.ts` is the single authority every creation path routes through —
the internal form now, the public page next slice — the way `provisionStaff` is
for staff. It drops past starts, and:

1. Recompute availability. The requested `(start, stylist)` must appear in it.
   The client's slot list is never trusted.
2. Insert. **The exclusion constraint is the real arbiter**; a violation is
   caught and becomes the same failure as step 1.
3. For "any available": order candidates by bookings-that-day ascending, and on
   a constraint violation **try the next candidate** before giving up.

Step 3 is the reason the loop exists. Two customers choosing "any available" at
the same instant with two free stylists must **both succeed** — failing the
second would be a bug the customer experiences as a fully-booked salon that is
not. The loop is bounded by the candidate list, so it terminates.

Steps 1 and 2 report identically on purpose. A stale page and a lost race are
indistinguishable to the person booking, and both mean the same thing: pick
another time.

## 6. Screens

### 6.1 `/dashboard/settings`

New, guarded by `settings: ['update']`. Holds `slot_minutes` and **the currency
card, moved here from `/dashboard/services`** — currency was always a salon-wide setting
living on a catalogue screen because there was nowhere else to put it. Two
settings is enough to justify the page; the move is a relocation, not a rewrite.

### 6.2 `/dashboard/bookings`

A date, a branch, and the day's bookings in time order: time, stylist,
customer, service, status. Status changes inline.

### 6.3 The booking form

Customer by phone lookup (`findOrCreateByPhone`, which has had no caller until
now), service (`resolveService`, likewise), stylist or "any available", then the
slots from `available_slots`.

Internal, and not throwaway: it is the walk-in entry point the third slice
builds on.

## 7. Error semantics

- **409** — the slot is no longer available. Both the recheck and the
  constraint violation report this (§5), and "any available" reports it only
  after every candidate has lost.
- **403** — a role without the permission. `stylist` holds `booking:read` only,
  so status changes are front desk and up.
- **Cross-tenant reads as not-found**, and the composite FKs refuse the row
  outright (§3.4).
- **No 402.** The plan tiers cap branches and staff, not bookings.

## 8. Permissions

None to add. `lib/permissions.ts` already defines
`booking: ['create', 'read', 'update', 'cancel', 'reschedule']` and already
grants the full set to owner, admin and frontdesk, and `read` alone to stylist.

`settings: ['read', 'update']` likewise exists, held by owner and admin only —
which is the guard §6.1 wants without changing anything.

Per-stylist scoping — a stylist seeing or updating only their own day — is a
second scoping mechanism on top of the branch scoping every screen uses, and is
deferred rather than half-built.

## 9. Deliberately deferred

- **Walk-ins starting now.** The past-start filter in `lib/booking.ts` will
  refuse a booking that starts a minute ago. The walk-in slice adds a parameter
  to bypass it; recording it here so it is a decision, not a discovery.
- **Customer accounts.** Two one-line changes when loyalty lands: the no-org
  redirect in `requirePageOrg` (`lib/session.ts:137`) currently sends a user
  with no membership to `/onboarding`, which would invite a customer to create
  a salon — wrong door, not an open one; and `customers.user_id` (nullable) is
  the claim link.
- **Recurring availability, buffers between appointments, resources/rooms.**
  None are in the PRD's MVP.

## 10. Testing

Vitest against real Postgres for `available_slots` — the feature is a query
rule, so SQL assertions cover it better than driving screens.

1. A service that does not fit before closing is not offered — 19:30 is the
   last 90-minute start against a 21:00 close, and 20:00 is absent.
2. A 45-minute grid starts at the interval's opening time: 09:00, 09:45, 10:30.
3. Changing `slot_minutes` changes tomorrow's offered starts and leaves an
   existing booking's own start and end untouched (§2.3).
4. An existing booking removes **exactly** the starts its range covers — the
   one immediately before it, whose service would overlap, is gone; the one
   ending exactly at its start survives (`'[)'`).
5. A time-off block removes a window the same way, and leaves the two
   surrounding windows bookable (scheduling spec §2.3).
6. A closed day, and a day where branch and staff hours do not overlap, both
   yield nothing.
7. **Multiple intervals in one day** — the constraint `staff_working_hours`
   returns a set for. Asserted by making the function return two rows.
8. A service not offered at that branch yields nothing, even with a free and
   qualified stylist.
9. A stylist not linked to the service yields nothing for that service.
10. `slot_minutes = 7` is refused by the check constraint.

Two connections, the pattern that caught the currency race:

11. Both book the same slot → exactly one succeeds, the loser gets 409.
12. Both pick "any available" with two free stylists → **both succeed**, on
    different stylists. This is the assertion the retry loop exists for, and a
    naive implementation fails it.
13. The constraint refuses an overlap regardless of the application path —
    asserted with a direct insert, since §3.3 is the guarantee and §5 is only
    the polite path to it.
14. Cancelling releases the slot; the same start becomes bookable again.

Playwright:

15. Book through the form, see it on the day, cancel it, watch the slot return.
16. A stylist is refused the status actions; front desk is not.

**Every load-bearing assertion gets break-and-restore evidence.** Seven
assertions in this project have passed for the wrong reason; each was caught by
breaking the code and watching, never by review. **The break must compile** — an
edit that fails the build fails the run without exercising anything.
