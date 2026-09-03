# Member Points — Design

**Date:** 2026-09-03
**Status:** implemented
**Covers:** PRD §5.7's last unbuilt piece — *"simple points rule: Rp X spent =
1 point (configurable). Redemption is post-MVP."*

## 1. Goal

Give a salon a loyalty number it can point at, without inventing a loyalty
programme nobody asked for.

### In scope

- A per-salon rate: how much spending earns one point, or nothing at all
- Points earned at checkout, and given back when a sale is voided
- A balance on the customer profile, and points-earned on the receipt

### Out of scope

- **Redemption.** §5.7 says post-MVP by name. Nothing spends points, so
  nothing needs a spend path, a tier table, or an expiry rule — and each of
  those is a business conversation, not a schema decision.
- **Points on retail vs services.** The rate applies to what was paid. Salons
  that want to exclude retail can have that when they ask.

## 2. Decisions

### 2.1 The rate is "rupiah per point", and null means OFF

`points_per_unit` on `salon_profiles`: `10000` means every Rp 10.000 spent
earns one point.

**Nullable, and null is the default.** A salon not running a loyalty scheme
should see no points anywhere — not a zero balance, which reads as "you have
earned nothing" rather than "we do not do this". The same distinction base
salary makes between null and zero.

Stored as the divisor rather than a points-per-rupiah fraction, because §5.7
phrases it that way and because an integer divisor needs no float anywhere.

### 2.2 Points are a LEDGER

`customer_points` rows with a signed amount, summed for a balance. The third
ledger in this product, for the third time the same reason: **a void writes the
negation and the balance corrects itself**, with no report having to remember
which rows to skip.

A cached balance on `customers` would be a second source of truth that drifts
the first time anything fails halfway.

**ponytail: balance is `sum()` per read.** Ceiling: a customer with thousands
of rows makes their profile slow. Upgrade path when that is real: a
materialized balance refreshed by trigger — the ledger stays authoritative.

### 2.3 Earned on what was PAID, floored, and symmetric

The total after discount, not the subtotal: "Rp X spent" is what the customer
actually handed over.

Floor, because part of a point is not a point.

**Symmetric around zero**, and this is the bit that bites. A reversal's total
is negative, and `floor(-15.5)` is `-16` while the sale earned `15` — so a
void would take back one more point than it gave. Sign is taken out, the
magnitude floored, and the sign restored. Exactly the trap
`commissionFor`'s rounding hit, which is why that helper is reused rather than
re-derived.

### 2.4 Earned at checkout, immutable after

Written inside the sale's own transaction, like commissions and stock, so a
failure anywhere leaves neither the sale nor the points behind.

The same `refuse_settled_line_write` trigger guards them: writable while the
parent transaction is `open`, refused after. A settled sale's points are as
fixed as its lines.

### 2.5 A sale with no customer earns nothing

Not a zero row — no row. §5.7 keys members by WhatsApp number, and a walk-in
who gave no number is not a member yet. This is the cost of making the customer
optional at the POS, named where it lands.

## 3. Data model

### 3.1 `salon_profiles.points_per_unit`

`integer`, nullable. Check: null or > 0. Zero would mean "one point per rupiah
divided by nothing", which is a division by zero rather than a business rule.

### 3.2 `customer_points`

`id`, `organization_id`, `customer_id`, `transaction_id`, `points` (signed,
non-zero), `created_at`.

Unique on `transaction_id` — one sale earns one points row, as a constraint.
Composite foreign keys, as everywhere else.

## 4. Testing

Vitest against real Postgres:

1. No rate configured earns nothing at all.
2. A rate of 10.000 on a 150.000 sale earns 15.
3. Points are earned on the total AFTER discount.
4. Partial points are floored, not rounded.
5. A void gives back EXACTLY what the sale earned — the asymmetric-floor case.
6. A sale with no customer writes no row.
7. A rate of zero or negative is refused by the constraint.
8. One sale cannot earn two points rows.
9. Points cannot be edited once their transaction is settled.
10. Another salon's customer never appears in a balance.

Playwright:

11. Setting a rate makes points appear; clearing it makes them disappear.
12. A sale shows points earned on the receipt and raises the profile balance.
13. Voiding that sale returns the balance to where it was.

### 4b. Caught before it shipped

`writePoints` originally read `transactions.total` directly. In `voidSale` it
runs **before** the statement that negates the reversal's amounts — so a void
would have **added** points instead of giving them back. The sign now comes
from `reverses_id`, the same way `moveStockForSale` reads its direction, and
breaking it back fails the void assertion.

Also worth naming: **turning the scheme on is not retroactive.** Points are
recorded at checkout, so sales made before a rate existed earned none and stay
that way. That falls out of the ledger being a record rather than a
computation, and it is the right behaviour — a salon should not be able to
grant history.

**Every load-bearing assertion gets break-and-restore evidence.**
