# Staff Commission — Design

**Date:** 2026-09-03
**Status:** implemented
**Covers:** PRD §5.3 (P1), and the `commission` seam left named in
`lib/pos.ts`

## 1. Goal

Answer, without anyone opening a spreadsheet: **what does this stylist earn
this month?**

§12's discovery questions include *"who calculates commissions today, and how
long does it take?"* — which is the PRD saying this is a known pain at Ovarya.
A recap that is simply *there* is the demo beat.

### In scope

- Where a commission rule lives, and how one is resolved
- A commission record per completed line, written at checkout
- Reversal, so a voided sale does not pay out
- The monthly recap, the owner's liability view, and a stylist's own earnings
- Per-line staff attribution in the POS, which does not exist yet

### Out of scope

- **Payroll** (§5.9, P2). This produces the number payroll consumes.
- **Product commission — decided, not deferred.** Only services earn.
  `commission_rule` is keyed by service, so a product line joins to nothing and
  earns nothing even when it names a performer (asserted in
  `tests/inventory.db.test.ts`). Salons that push retail often do pay on it;
  this one does not, and that is the answer rather than an omission.
- **Payout tracking.** Whether a commission has been *paid* is payroll's
  question, not this slice's.

## 2. Decisions

### 2.1 Rules resolve in three steps, mirroring branch pricing

§5.3 wants rules "per service and per staff". §7 puts them on `service_staff`.
Configuring 15 services × 6 staff by hand is not a product, so a rule resolves
the way a branch price already does — a default, overridden where it matters:

| Level | Where | Typical use |
|---|---|---|
| salon | `salon_profiles` | "everyone gets 10%" |
| service | `services` | "smoothing is 15%, margins differ" |
| service + staff | `service_staff` | "the senior stylist gets 20% on smoothing" |

A view (`commission_rule`) does the `coalesce`, exactly as
`service_branch_pricing` does for price. No new table, and the precedent is
already in the codebase.

### 2.2 Percent is basis points; flat is minor units

`commission_kind` (`percent` | `flat`) plus `commission_value`, an integer
either way.

**Basis points, not a percentage float.** 12.5% is 1250 and stays exact; a
`numeric(5,2)` would work too but every read would then have to remember to
round the same way. One integer, one rounding site — the same rule
`parseMoney` learned the hard way twice.

Rounding is half-up to the currency's minor unit, applied once when the
commission is computed and stored.

### 2.3 Commission is a RECORD, written at checkout

Not derived on read. Two reasons, and the second is the one that matters:

- The rule changes. A stylist promoted to 20% must not retroactively earn 20%
  on last month's work — the same snapshot argument as line prices and booking
  durations.
- Payroll pays on it. A number that is recomputed every time it is looked at
  is a number that can quietly differ from the one somebody was paid.

The record snapshots the rule applied (`kind`, `value`) alongside the amount,
so a recap can always explain itself.

### 2.4 A void reverses the commission, with no special case

`voidSale` already copies lines with negated amounts. Commissions are computed
from those lines, so a reversal's commissions come out negative for free.

That gives the same ledger property revenue has:

```
sum(amount) per staff per month  =  what they earned
```

with nothing anywhere having to remember which rows to subtract. A void that
left the commission standing would pay a stylist for a sale that did not
happen.

### 2.5 Commission records are immutable, by the same trigger

They hang off a settled transaction, so they follow the same rule its lines
do: writable while the parent is `open`, refused after. The existing
`refuse_settled_line_write` function already expresses this; the trigger is
simply attached to one more table.

### 2.6 A line with no stylist earns nothing, and that is a UI problem

`transaction_lines.staff_user_id` exists but the POS never sets it. A sale
from a booking should attribute to that booking's stylist; a direct sale needs
the cashier to say who did the work.

Until now that column was a seam. This slice makes it load-bearing, so the
cart grows a performer select per line — defaulted from the booking, required
for nothing, because a retail-style sale with no stylist is legitimate and
simply earns no commission.

## 3. Data model

### 3.1 Rule columns

`commission_kind` (`text`, nullable) and `commission_value` (`integer`,
nullable) on `salon_profiles`, `services` and `service_staff`. Checks: the
pair is both-null or both-set; `kind in ('percent','flat')`; value ≥ 0; and a
percent value ≤ 10000 (100%), because a rate above the sale price is a typo,
not a business model.

### 3.2 `commission_rule` view

`(service_id, user_id, organization_id, kind, value)` — the coalesce chain
from §2.1, `security_invoker = true` like every other view here.

### 3.3 `commissions`

`id`, `organization_id`, `transaction_id`, `transaction_line_id`,
`staff_user_id`, snapshotted `kind` and `value`, `amount` (minor units, signed),
`created_at`.

Unique on `transaction_line_id`: one line earns one commission, as a
constraint rather than a check somebody remembers.

Composite foreign keys throughout, as everywhere else.

## 4. Screens

- **`/dashboard/commissions`** — a month, per staff: services completed,
  revenue generated, commission earned. Guarded by `commission:['read']`
  (owner and admin).
- **A stylist holding only `commission:['read:own']`** sees the same page
  narrowed to themselves — PRD §5.3's "my earnings this month".
- **The rule** is edited on `/dashboard/services/[id]` next to the performers
  it applies to, with the salon default on `/dashboard/settings`.

## 5. Testing

Vitest against real Postgres:

1. The salon default applies when nothing overrides it.
2. A service rule beats the salon default; a service+staff rule beats both.
3. A percent rule rounds half-up to the minor unit, once.
4. A flat rule scales with quantity and ignores price — two haircuts earn
   twice.
5. A line with no stylist produces no commission record at all.
6. Voiding produces negative commissions, and the month nets to zero.
7. A rule changed after the sale does not change what was earned.
8. Commission rows cannot be edited once their transaction is settled.
9. One line cannot earn two commissions.
10. A percent above 100% is refused by the constraint.

Playwright:

11. A sale attributed to a stylist appears in that month's recap.
12. A stylist sees only their own row; an owner sees everyone.
13. Voiding removes the earnings from the recap.

### 5b. What the breaks caught

- **A bug the DB test had been hiding.** `transactions_one_per_booking` keyed
  on `status <> 'reversal'`, which stopped being right the moment a void began
  building its reversal as `open` (§2.5 of the POS spec). Voiding any
  booking-backed sale failed outright — but the existing assertion inserted a
  row with `status = 'reversal'` directly and never went through the open
  phase, so it passed. Rewritten to drive `voidSale`, and the index now keys
  on `reverses_id is not null`, which is true from the reversal's first INSERT
  and cannot drift out of step with the lifecycle again (migration 0021).
- **A rounding test that proved nothing.** 12.5% of 99999 is 12499.875, which
  rounds the same way in both directions — so swapping the symmetric rounding
  for plain `Math.round` failed nothing. Only an *exact* half separates them:
  `Math.round(0.5)` is 1 and `Math.round(-0.5)` is -0.
- **A guard the join already subsumed.** `staff_user_id is not null` could be
  deleted without failing anything, because `commission_rule` is keyed by user
  and NULL joins to nothing. Deleted rather than kept — a condition that reads
  as a guard but cannot be exercised is worse than none.

**Every load-bearing assertion gets break-and-restore evidence.** Ten
assertions in this project have passed for the wrong reason; every one was
caught by breaking the code and watching. **The break must compile.**
