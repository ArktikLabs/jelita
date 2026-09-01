# Customers — Design

**Date:** 2026-09-01
**Status:** approved
**PRD:** §5.7 Member Database

## 1. Goal

A salon's customer records: who they are, how to reach them, and what the
stylist needs to remember about them. Booking will attach a customer to every
appointment; POS will look one up at checkout.

### In scope

- `customers` table, salon-wide
- `/customers` list with search across name and number
- `/customers/new`
- `/customers/[id]` — edit, notes, deactivate/reactivate

### Out of scope, and why

- **Auto-create from booking** — no bookings exist yet. This slice publishes
  the lookup that booking will call (§4).
- **Visit history, total spend, points, and the points rule** — all written by
  checkout, which does not exist. Deliberately keeps money out of this slice
  entirely.
- **Merging duplicates.** The unique index prevents the common case; a manual
  merge tool is post-MVP.
- **A plan cap.** `CAPPED_RESOURCES` is branches, staff, services, products.
  Capping how many customers a salon may have would be a strange thing to sell.

## 2. Decisions

### 2.1 Salon-wide, not per branch

A customer belongs to the salon and is visible at every branch. Someone who
books at one location and buys at another is one person with one history.

### 2.2 The phone number is the identity, normalized — binding constraint

PRD §5.7 keys customers on the WhatsApp number, and booking will auto-create
from it, so dedup has to be deterministic rather than advisory.

`phone_key` holds a normalized form: digits only, with the Indonesian
prefixes canonicalised so `0812…`, `+62812…` and `62812…` all produce the same
value. A **partial unique index** on `(organization_id, phone_key) where
phone_key is not null` enforces one customer per number per salon.

`phone` stores what was typed, so the front desk sees the number as the
customer gave it. `phone_key` is derived on write and is never displayed.

### 2.3 Phone is optional

A cash walk-in who declines to give a number still gets a record. Many
customers may have no phone without colliding, because NULLs are distinct in a
Postgres unique index (§2.2).

The cost, accepted: two people genuinely sharing one number — a mother and
daughter on one handset — means the second is recorded without it. Allowing
duplicates instead would make booking's auto-create pick between matches, and
picking wrong attaches an appointment to the wrong person's history.

### 2.4 Deactivate, never delete

Consistent with branches, staff and services. Bookings and transactions will
point at these rows.

## 3. Data model

`customers`, RLS enabled with zero policies like every other table here.

| column | notes |
|---|---|
| `id` | PK |
| `organization_id` | FK → `organizations.id`, cascade |
| `name` | not null |
| `phone` | nullable, as typed |
| `phone_key` | nullable, normalized (§2.2) |
| `notes` | nullable — colour formula, allergies |
| `active` | not null, default true |
| `created_at`, `updated_at` | |

- Partial unique index on `(organization_id, phone_key) where phone_key is not null`.
- Index on `(organization_id, name)` for the list.
- `unique (organization_id, id)`, so a future booking or transaction can carry a
  composite FK and make a cross-tenant reference unrepresentable — the pattern
  the services join tables use.

## 4. The interface booking and POS will consume

`lib/customer.ts`:

- `normalizePhone(input: string): string | null` — the single source of the
  rule in §2.2. Returns null for input with no digits.
- `listCustomers(organizationId, opts?: { search?: string })`
- `getCustomer(customerId, organizationId)`
- `findOrCreateByPhone(organizationId, { name, phone })` — the lookup booking
  will call. Returns the existing customer for a matching `phone_key`, else
  creates one. **Published now with no caller**, so booking does not have to
  invent its own dedup and risk a second normalization rule.

Every query carries `organization_id` in the same statement.

## 5. Screens

Following the `/staff` and `/services` patterns: Server Actions,
`useActionState`, destructive `Alert`, Indonesian copy.

- `/customers` — list, searchable across name and `phone_key`, so typing
  `0812` finds a customer stored as `+62812`. Guarded by `customer: ['read']`.
- `/customers/new` — name, phone, notes. Guarded by `customer: ['create']`.
- `/customers/[id]` — edit, notes, deactivate/reactivate. Guarded by
  `customer: ['update']`.

Owner, admin and front desk hold all three. Stylists hold `read` only, so they
reach the list but are redirected from create and edit.

## 6. Error semantics

- **403** — a stylist reaching create or edit.
- **409** — a number already used by another customer in this salon.
- **Cross-tenant reads as not-found**, never as a leak.
- No 402: there is no cap.

## 7. Testing

`scripts/customer-check.mjs`, same conventions: no framework, assert-and-count,
unconditional section-0 reset, driven through the dev server on 3001.

The assertions that carry weight:

1. `0812…`, `+62812…` and `62812…` normalize to the same `phone_key`, and a
   second customer with any of those spellings is refused with the 409 copy.
2. Two customers with **no** phone both save — the partial index does not
   collide on null.
3. Searching `0812` finds a customer stored as `+62812`.
4. A number belonging to another salon does **not** collide — the unique index
   is per organization.
5. `findOrCreateByPhone` returns the existing customer rather than creating a
   second, and creates one when there is no match.
6. A stylist is redirected from `/customers/new` and `/customers/[id]`.
7. Another salon's customer id reads as not-found and leaks no name.

Every load-bearing assertion gets break-and-restore evidence.

**Pinned suites:** auth 70, plan 38, ui 16, branch 44, staff 188, service 125.
