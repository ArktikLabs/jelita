# Inventory & Stock — Design

**Date:** 2026-09-03
**Status:** implemented
**Covers:** PRD §5.4 (P1), the stock seam left named in `lib/pos.ts`, and the
retail half of §5.2's cart

## 1. Goal

Know what is on the shelf, per branch, and have selling it say so without
anyone typing a second thing.

### In scope

- `products` — retail and internal use, with a reorder level
- `stock_movements` — an append-only ledger, in and out, with actor
- On-hand per branch, derived from the ledger
- Retail lines in the POS cart, deducting stock at checkout
- A low-stock view

### Out of scope

- **Purchase orders and suppliers.** §5.4 asks for movements, not procurement.
- **Per-branch product pricing.** Services have branch overrides because a
  treatment's price varies by location; a bottle of shampoo does not. One
  price per product, salon-wide.
- **Stock take / cycle counting.** An `adjustment` movement is the MVP's whole
  reconciliation story.
- **Commission on product sales.** §5.3's rules are keyed by service. Retail
  commission is a real thing salons do, and it is not in this slice.

## 2. Decisions

### 2.1 Stock is a LEDGER, never a counter

`stock_movements` holds signed quantities; on-hand is their sum. §5.4 asks for
"a stock movements ledger: in (purchase), out (sale/usage/adjustment), with
timestamp + actor", and a cached counter alongside it is a second source of
truth that drifts the first time anything fails halfway.

Same property revenue and commission already have: **sum the rows and you have
the answer**, with nothing to reconcile.

**ponytail: on-hand is `sum()` over movements, computed per read.** Ceiling: a
product with tens of thousands of movements makes the products list slow.
Upgrade path when that is real: a materialized per-(product, branch) balance
refreshed by trigger — the ledger stays the source of truth either way.

### 2.2 The ledger is append-only, enforced

A correction is another movement, not an edit. Updates and deletes are refused
by a trigger — not for the same reason transactions are frozen after
completion, but because that is what a ledger *is*: the history of what
happened, including the mistakes.

Simpler than the transaction rule, too: there is no `open` state to allow.

### 2.3 Selling below zero is allowed, and shown

A sale is not refused for want of stock.

A salon's counts are approximate — someone opens a bottle without logging it,
a delivery is not entered until Friday. Blocking the till because the ledger
says zero punishes the customer for a bookkeeping gap, and the front desk's
workaround is to sell it anyway and never tell the system, which is strictly
worse.

So the ledger records the truth, including a negative balance, and the
products list flags it. **The upgrade path is a per-product "refuse when
short" flag**, if a salon ever wants one — but the default should not be the
thing that stops a sale.

### 2.4 Retail lines join the cart; internal ones never do

`products.kind` is `retail` or `internal`. Only retail appears in the POS.
Internal stock moves through `usage` movements, which is §5.4's "deducted
manually or via simple usage log in MVP".

`transaction_lines` gains `kind` and a nullable `product_id`, and `service_id`
becomes nullable, with a check that **exactly one** of the two is set. This is
the change flagged in the POS spec §3.2 as "one line when products land", and
it is cheaper now than after the demo seed writes a month of sales.

### 2.5 A void returns the stock, and the direction comes from `reverses_id`

`voidSale` mirrors lines by negating **amounts** and keeping quantity positive,
because a line's quantity is what was performed.

The obvious move was therefore to take the direction from the sign of the
line's net amount, the way commissions do. That is wrong here, and a test
caught it: **a line discounted to 100% nets zero**, a sign of zero is a
movement of zero, and the check constraint refuses it — so a free bottle would
never leave the shelf.

`reverses_id` says which way stock moves without depending on what anything
cost. A void puts the bottle back with nothing here having to know a void
happened.

### 2.6 Movements carry their actor and their reason

`reason` is `purchase` | `sale` | `usage` | `adjustment`; `actor_user_id` is
who did it; `transaction_id` links a `sale` movement to the sale that caused
it. §5.4 asks for the first two by name, and the third is what makes a void's
return traceable to the void.

## 3. Data model

### 3.1 `products`

| column | notes |
|---|---|
| `id`, `organization_id` | |
| `name`, `sku` | `sku` nullable, unique per salon when set |
| `kind` | `retail` \| `internal` |
| `price` | minor units; null for internal, which is never sold |
| `reorder_level` | integer, default 0 — the low-stock threshold |
| `active` | |

Check: a retail product has a price; an internal one does not.

### 3.2 `stock_movements`

`id`, `organization_id`, `team_id`, `product_id`, `quantity` (signed, non-zero),
`reason`, `actor_user_id`, `transaction_id` (nullable), `note`, `created_at`.

Composite foreign keys throughout. Append-only by trigger (§2.2).

### 3.3 `stock_on_hand` view

`(product_id, team_id, organization_id, on_hand)` — the sum, so the products
list and the POS read the same number rather than each summing it their own way.

## 4. Testing

Vitest against real Postgres:

1. On-hand is the sum of movements, per branch — one branch's stock is not
   another's.
2. A movement cannot be updated or deleted.
3. A zero-quantity movement is refused.
4. Selling deducts, and the ledger records the sale that caused it.
5. Voiding returns exactly what the sale took.
6. Selling below zero is allowed and produces a negative on-hand.
7. An internal product cannot be sold at the POS.
8. A retail product with no price is refused by the constraint.
9. A line must name exactly one of a service or a product.
10. Cross-tenant products, branches and transactions are all refused.

Playwright:

11. A retail product is added to a cart alongside a service, and stock drops.
12. Voiding that sale puts it back.
13. Low stock is flagged at or below the reorder level.
14. Front desk may read stock but not adjust it.

### 4b. What the breaks caught

- **The zero-net line** (§2.5), found before the code shipped.
- **A test premise that was simply wrong.** "A stylist may read stock" —
  `lib/permissions.ts` grants `product:['read']` to *front desk*, not stylist.
  The page redirected, the assertion failed, and the test now covers both
  roles.
- **A guard nothing could falsify.** The cart posted
  `isProduct ? null : staffUserId`, but a product line never has one (the
  select is not rendered) and `commission_rule` is keyed by service, so a
  product joins to nothing regardless. Deleted, and the guarantee underneath
  asserted instead: a product line naming a performer still earns nothing, and
  breaking that join fails it.

**Every load-bearing assertion gets break-and-restore evidence.** The rule has
now caught a bug in every slice it has been applied to. **The break must
compile.**
