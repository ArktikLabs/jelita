# Cashier / POS — Design

**Date:** 2026-09-03
**Status:** draft
**Covers:** PRD §5.2 (Cashier/POS, P0), §5.10 (Payment recording, P0), and the
branding half of §7's white-label line

## 1. Goal

Turn a finished appointment into money that the books can be trusted about.

Booking was about a guarantee the database enforces. **POS is about a record
nobody can quietly change** — every report, commission figure and payroll run
downstream is only as trustworthy as the immutability of the rows underneath.

### In scope

- `transactions`, `transaction_lines`, `transaction_payments`
- Immutability after completion, enforced in the database
- Void as a reversal record
- Checkout from a booking, and as a direct sale
- Payment method recording behind a `PaymentProvider` seam
- A printable receipt
- Salon branding — logo and brand colour — because the receipt needs it

### Out of scope

- **Points.** Deferred with the member database (§5.7, P1). The seam is named
  in §6; nothing is built.
- **Stock deduction and commission records.** Same: seams, not stubs.
- **Split payment.** The schema is one-row-per-payment so it costs nothing
  later; the UI takes one method per sale (PRD marks split P1).
- **Retail products in the cart.** No products table exists yet (§5.4, P1).
  Services-only, and §3.2 says what changes when products land.
- **A real payment gateway.** See §4.3 for exactly how far the seam goes.

## 2. Decisions

### 2.1 Immutability is a trigger, not a convention

§5.2: *"Every transaction is immutable after completion (void creates a
reversal record, not a delete)."*

A `before update or delete` trigger on `transactions` and
`transaction_lines` refuses any row whose status is not `open`. The
`open → completed` transition is the last write a transaction ever receives.

In the database for the same reason `bookings_no_overlap` is: application code
can forget, and the code most likely to forget has not been written yet. A
report, a migration, an admin fix at 2am — all of them meet the same wall.

### 2.2 A void is a new row, and reversals are negative

Voiding writes a **reversal transaction** whose lines mirror the original with
negated amounts, linked by `reverses_id`. `unique (reverses_id)` means a
transaction can be reversed at most once — a constraint, not a check somebody
remembers to write.

Reversal amounts are stored **negative**, deliberately, so that:

```
sum(total) over every non-open transaction  =  revenue
```

with no special-casing anywhere. The alternative — positive amounts plus a
status the reader must remember to subtract — puts a correctness burden on
every report that will ever be written, including the ones written by someone
who has not read this document.

### 2.3 Discounts are stored as AMOUNTS, never percentages

If the UI offers "10%", it computes the amount and posts the amount.

A stored percentage must be re-multiplied at every read, and every read is a
chance to round differently from the receipt the customer is holding. Storing
the amount leaves **exactly one rounding site** — percentage to minor units, in
the UI, once — instead of one per query.

This project has already shipped two silent order-of-magnitude money bugs
(`parseMoney`, twice). One rounding site is worth a great deal.

A check constraint keeps `total >= 0` except on reversals, so a discount larger
than the subtotal is unrepresentable rather than merely validated.

### 2.4 Lines snapshot their terms

Name, unit price, quantity and discount are copied onto the line, exactly as
`bookings` snapshots duration and price (booking spec §2.5). A receipt reprinted
next month must say what was charged, not what the price list says today.

### 2.4b The cart is a form, not a row

`transactions_one_per_booking` counts **open** rows. A durable cart abandoned
against a booking would therefore block that booking from ever being charged,
with the customer standing at the counter — and no amount of cleanup logic
makes that a good design.

So the cart lives in the page, and `open` exists only **inside the write
transaction**: insert, add lines, take payment, complete, commit. Nobody ever
observes an open row, the triggers keep the semantics they were built with,
and there is nothing to abandon, resume or expire.

§5.2 asks for checkout in ≤5 clicks, which is one screen. A durable cart would
be machinery for a multi-session flow the PRD does not ask for.

### 2.4c Prices are never posted

The caller names services, quantities and discount **amounts**. The server
resolves the price from `service_branch_pricing` itself, inside the same
transaction, so a branch override applies and a posted price cannot.

The same class of hole as the posted `teamId` found in the booking action —
except the field is money.

### 2.5 Checkout completes a booking that is still `pending`

`lib/booking.ts`'s lifecycle is `pending → confirmed → completed`, and refuses
`pending → completed`. Checkout widens that: someone who paid clearly showed up,
and money is better proof of attendance than a front-desk click.

Recorded here because it is a deliberate widening of a table that otherwise
exists to refuse exactly this.

### 2.7 Voiding is bounded by the shift

A void is allowed while the sale's till session is open, and refused after.
The boundary has to be declared by somebody, so `shifts` is a row per branch:
opened, closed, by whom.

**Enforced by a trigger**, because a void is an *insert* of a reversal — the
immutability trigger guards updates and does not cover it, and "the window has
shut" is exactly the rule a report or a fix-it script would not think to check.

**No open shift at checkout opens one.** A till that refuses to sell because
somebody forgot a button is the worst failure a POS can have. Closing stays
explicit: closing is the act that locks the takings, and it is where a Z-report
will go. No cash counting in the MVP — this is a boundary, not a drawer.

`unique (team_id) where closed_at is null` means one open shift per branch, so
two concurrent first-sales cannot split the day across two windows that both
look current.

**A reversal is built `open` and settled at the end**, exactly as a sale is.
Not written straight to `reversal`: the line trigger refuses writes whose
parent is past `open`, so a reversal born settled could never be given its own
lines. Weakening that trigger to admit reversals would open a door on every
future path; giving the void the same lifecycle keeps the rule absolute. Its
amounts start positive for the same reason — `transactions_total_sign` permits
a negative total only on a reversal — and are negated by the one statement that
settles it.

### 2.8 Receipts carry a running number

A per-salon integer, allocated by `update ... returning` at completion. One
statement, so it serialises per salon without an explicit lock and cannot hand
two sales the same number; `unique (organization_id, invoice_no)` makes a
duplicate unrepresentable regardless. A void gets its own number, because a
void is a document someone receives.

Not year-prefixed with an annual reset: that needs a reset rule and a stored
year, and if Indonesian tax invoicing ever matters it will impose its own
format.

### 2.6 Branding goes to S3-compatible object storage

§7 asks for "salon name, logo, brand color, currency in settings — demo can be
re-skinned per prospect in minutes". Currency is already on `salon_profiles`;
logo and brand colour join it.

**The bytes go to an S3-compatible store.** MinIO in dev and in the test suite
(`docker-compose.test.yml`), real S3 in production — the same protocol either
way, so the difference between environments is an endpoint and a pair of
credentials, never a code path.

`forcePathStyle` is what makes MinIO work: virtual-host addressing needs DNS
per bucket, which a container on a compose network does not have.

The MinIO service carries **no volume**, following the database's disposability
rule: a run starts with an empty bucket, and nothing a crashed run left behind
can leak into the next.

**The app does not create its own bucket.** In production that needs
permissions no application should hold, and a typo in the bucket name would
quietly succeed instead of failing on the first upload. The bucket is
infrastructure — a one-shot `mc` job in compose now, terraform later.

`salon_profiles` records only that a logo exists (`logo_key`) and when it
changed; the bytes never touch Postgres.

**Served through `/api/salon/logo`, not a bucket URL.** The bucket stays
private, there is no CORS or bucket policy to get right, and dev and production
share one URL shape. The app is in the byte path for a ~50 KB file behind a
long cache header — and a CDN can front the same route without the pages
knowing.

**SVG is refused**, and the type is decided by the **magic bytes** rather than
the declared content type. A browser sniffs, so trusting the client's label is
trusting the client — and an SVG is a script container that would be served
from the app's own origin on a page that also renders a booking form. PNG,
JPEG and WebP.

## 3. Data model

### 3.1 `transactions`

| column | notes |
|---|---|
| `id` | PK |
| `organization_id`, `team_id` | salon and branch (§5.8: every core table carries a branch) |
| `customer_id` | nullable — a walk-in sale need not name anyone |
| `booking_id` | nullable — direct sales have none |
| `status` | `open` / `completed` / `reversal` |
| `reverses_id` | nullable, `unique` (§2.2) |
| `subtotal`, `discount`, `total` | minor units |
| `currency` | snapshot |
| `completed_at` | nullable while open |

Checks: `status = 'reversal' or total >= 0`; `booking_id` unique among
non-reversal rows, so one booking cannot be charged twice.

### 3.2 `transaction_lines`

`transaction_id`, `service_id`, snapshotted `name`, `unit_price`, `quantity`,
`discount`, and `line_total` as a generated column so it cannot disagree with
its parts.

**When products land** this gains `kind` (`service` | `product`) defaulting to
`service`, and a nullable `product_id`. Deliberately not added now: a column
whose only value is `'service'` and an FK to a table that does not exist are
scaffolding, and the backfill is one line.

### 3.3 `transaction_payments`

`transaction_id`, `method` (`cash`/`transfer`/`qris`/`debit`/`credit`),
`amount`, `provider`, `provider_ref`, `status`, `created_at`.

One row per payment, so split payment is a UI change later rather than a
migration.

### 3.4 Branding on `salon_profiles`

`logo_key` (`text`, nullable), `logo_updated_at` (`timestamptz`, nullable, the
cache buster) and `brand_color` (`text`, a `#rrggbb` check). The bytes live in
the object store under `salons/<organizationId>/logo`, keyed per salon so one
prospect's re-skin cannot reach another's.

### 3.5 Cross-tenant rows stay unrepresentable

Composite foreign keys throughout, as everywhere else:
`(organization_id, customer_id)`, `(organization_id, booking_id)`,
`(organization_id, service_id)`, `(team_id, organization_id)`.

## 4. Behaviour

### 4.1 Completing a checkout

In one transaction:

1. `sum(payments) = total`, or refuse. Not a constraint — payments are written
   before completion — so a check at the completion statement.
2. `status = 'completed'`, `completed_at = now()`.
3. Mark the linked booking `completed` (§2.5).

Seams, named and not stubbed: stock deduction (§5.4), commission records
(§5.3), points (§5.7).

### 4.2 Voiding

`pos: ['void']` — held by owner and admin, **not** front desk, which is already
true in `lib/permissions.ts`. Writes the reversal (§2.2). The original row is
never touched; the trigger would refuse it anyway.

### 4.3 How far the payment seam actually goes

Real now: **where a provider plugs in** and **what it records** —
`provider`, `provider_ref`, and a per-payment `status`. `ManualPayment` answers
`settled` immediately.

**Not built, and it matters:** a gateway that settles asynchronously needs a
transaction state between `open` and `completed`, and the MVP has nothing to
exercise one with. Building an untestable state to make the talking point
sound bigger would be worse than saying this. "Going live is configuration" is
true of the recording path; the async lifecycle is a real change.

## 5. Screens

- **`/dashboard/pos`** — new sale. Customer by phone, add services, discounts,
  payment method, complete. `?bookingId=` prefills from the day list.
- **`/dashboard/transactions`** — the list, with void for those who may.
- **`/dashboard/transactions/[id]`** — the receipt, printable, carrying the
  salon logo, brand colour, and the branch's name, address and phone.
- **`/dashboard/settings`** — logo upload and brand colour, alongside currency
  and the slot grid.
- **`/api/salon/logo`** — serves the bytes with a long cache keyed on
  `updated_at`, so the receipt and the public page do not re-fetch it.

§5.2 asks for checkout in ≤5 clicks: from the day list that is
*Checkout → payment method → Complete*.

## 6. Deliberately deferred

- **Points**, **commission records**, **stock deduction** — §4.1's seams.
- **Split payment** — schema ready, UI not.
- **Products in the cart** — §3.2.
- **Async payment providers** — §4.3.

## 7. Testing

Vitest against real Postgres:

1. A completed transaction cannot be updated, and cannot be deleted — asserted
   against the trigger, not through the app.
2. An open transaction can still be edited, so the trigger is not simply
   refusing everything.
3. A void writes a reversal whose lines negate the original, and the original
   is untouched.
4. A transaction cannot be reversed twice.
5. `sum(total)` over completed + reversal is zero after a full void — the
   ledger property §2.2 exists for.
6. A discount larger than the subtotal is refused by the constraint.
7. Completing with payments that do not sum to the total is refused, and
   nothing is marked completed.
8. Completing marks a linked booking `completed`, including from `pending`
   (§2.5).
9. One booking cannot be charged twice.
10. The database refuses a line, payment or transaction naming another salon's
    row.
11. `brand_color` refuses anything that is not `#rrggbb`.
12. An SVG upload is refused; so are bytes that merely claim to be an image,
    and a PNG signature that is only nearly right.
13. Bytes round-trip through the real store with their content type, an
    overwrite replaces rather than accumulates, and a salon with no logo
    answers null instead of throwing. Against MinIO, not a mock — a mocked
    client would prove only that the mock works.

Playwright:

13. Checkout from a booking in ≤5 clicks; the booking shows `completed`.
14. A direct sale with no booking and no customer.
15. Front desk may check out and discount but is refused void; owner may void.
16. The receipt renders the logo and brand colour.
17. Voiding shows the reversal and leaves the original readable.

### 7b. What the breaks caught here

- **`pgMentions` walking `cause`.** Drizzle wraps driver errors, so matching a
  constraint name on the top-level error never fires. This had already cost
  the booking engine a dead retry path; `lib/pg-error.ts` now exists so the
  next caller finds it instead of re-deriving it, and `lib/booking.ts` reads
  through it too.
- **Invoice allocation.** Replacing `update ... returning` with a read then a
  write fails only the concurrency assertion — which is the one that matters,
  and the one a single-threaded test would never have shown.

**Every load-bearing assertion gets break-and-restore evidence.** Ten
assertions in this project have passed for the wrong reason; every one was
caught by breaking the code and watching, never by review. **The break must
compile.**
