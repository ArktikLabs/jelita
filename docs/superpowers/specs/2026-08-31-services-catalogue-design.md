# Services Catalogue — Design

**Date:** 2026-08-31
**Status:** approved for planning
**Predecessors:** `2026-08-30-branch-management-design.md`, `2026-08-31-staff-management-design.md`

## 1. Goal

Give a salon a catalogue of what it sells: name, how long it takes, what it
costs, which branches offer it, and who can perform it. Both P0 flows depend
on it — booking has nothing to offer without it, POS has nothing to price.

### In scope

- `/services` list, grouped by category, with the remaining plan quota shown
- `/services/new`
- `/services/[id]` — the service, its per-branch overrides, and who performs it
- Owner-defined service categories
- Per-salon currency, set at onboarding
- `services` as a plan-capped resource

### Out of scope

- **Commission rates.** PRD §5.3 puts percentage-or-flat rates per service and
  per staff. The `service_staff` row this feature creates is where they will
  live, so adding them later is columns, not structure.
- **Retail products.** PRD §5.4 is a separate subsystem needing a stock ledger.
- **A settings screen.** Currency is the only salon-wide setting today; it gets
  a card on `/services` rather than a screen of its own (§5.4).
- **Booking and POS consumption.** This feature publishes `resolveService`;
  reading it is their work.

## 2. Decisions

### 2.1 Salon-wide catalogue, per-branch price and availability overrides

One catalogue per salon. A branch may override the **price** and may mark a
service **not offered here**. Duration stays salon-wide, so slot computation
has one answer per service and the booking engine never needs a branch in hand
before it can lay out a calendar.

Overrides are **sparse**: a row exists only where a branch differs. A null
price means *inherits*, so changing the salon price still moves every branch
that never overrode it.

### 2.2 Per-staff service lists

A staff member is linked to the services they may perform, so a nail
technician is not offered as bookable for a haircut. PRD §5.3 needs a
service×staff row for commission regardless; "can perform" rides on it.

### 2.3 One currency per salon

Each salon operates in a single currency, chosen at onboarding. There is no
in-salon conversion, no mixed carts, and no FX rates. Arktik still bills across
currencies because the plan tier is priced separately from what a salon
charges.

### 2.4 Money is an integer in the currency's minor unit — binding constraint

**Amounts are stored as integers in the currency's minor unit, never as
decimals.** The exponent varies by currency (IDR and JPY 0, SGD and USD 2, KWD
3), so `50000` is Rp 50.000 in an IDR salon and $500.00 in a USD one.

`SUPPORTED_CURRENCIES` in TypeScript carries each code's exponent and
validates what a salon may choose. It does not need to be a table until the
list is sold to someone.

Integers rather than `numeric` because commission divides money, and rounding
a decimal type invites half-unit drift. With minor units the remainder is
explicit and must be assigned deliberately.

### 2.5 Snapshots carry the amount AND the currency — binding constraint

**Every future record of money — a booking line, a transaction line, a
commission entry — stores the amount it charged and the currency code it was
in.** It never reads today's catalogue to render yesterday's receipt.

The amount half is the same rule as `branch_id` on work records. The currency
half exists because a salon that ever changes currency turns every historical
amount into an unreadable number: `50000` that was rupiah silently reading as
dollars.

This constraint binds features that do not exist yet. It is recorded here
because this is the spec that introduces money.

### 2.6 Currency is fixed once priced records exist

Freely settable while the catalogue is empty; refused afterwards. Switching
currency would reinterpret every stored amount by orders of magnitude.
Re-denominating an operating salon is a data migration, not a settings toggle,
and offering it as one in the UI would be worse than not offering it.

### 2.7 Deactivate, never delete

A service is deactivated, not deleted — history has to keep pointing at it.
Consistent with branches and staff.

## 3. Data model

Five tables. RLS enabled with zero policies on each, matching every other
table here: the app connects as owner and bypasses.

### 3.1 `salon_profiles`

Org-level settings, seeded by a trigger on `organizations` plus a backfill —
the same mechanism `branch_profiles` and `staff_profiles` use.

| column | notes |
|---|---|
| `organization_id` | PK, FK → `organizations.id`, cascade |
| `currency` | `char(3)`, ISO 4217, not null, default `'IDR'` |
| `created_at`, `updated_at` | |

Future salon-wide settings land here, so it earns its place beyond one column.

### 3.2 `service_categories`

Owner-defined per salon; salons differ too much for a fixed list.

| column | notes |
|---|---|
| `id` | PK |
| `organization_id` | FK → `organizations.id`, cascade |
| `name` | not null |
| `created_at`, `updated_at` | |

`unique (organization_id, id)` so §3.6's composite keys can reference it.

### 3.3 `services`

| column | notes |
|---|---|
| `id` | PK |
| `organization_id` | FK → `organizations.id`, cascade |
| `category_id` | nullable — an uncategorised service is still valid |
| `name` | not null |
| `duration_minutes` | `smallint`, not null, `> 0` |
| `price` | `bigint`, not null, `>= 0`, minor units (§2.4) |
| `active` | boolean, not null, default true |
| `created_at`, `updated_at` | |

- `unique (organization_id, lower(name))` — a duplicate name inside one salon
  is a 409. Case-insensitive, because "Potong Rambut" and "potong rambut" are
  the same thing to a receptionist.
- `unique (organization_id, id)` for §3.6.
- `category_id` uses a composite FK `(category_id, organization_id)` into
  `service_categories`, so a service cannot borrow another salon's category.

### 3.4 `service_branch_overrides`

Sparse: a row exists only where a branch differs.

| column | notes |
|---|---|
| `service_id`, `team_id` | composite PK |
| `organization_id` | carried for the composite FKs below |
| `price` | `bigint` **nullable** — null means *inherits* |
| `offered` | boolean, not null, default true |
| `created_at`, `updated_at` | |

### 3.5 `service_staff`

| column | notes |
|---|---|
| `service_id`, `user_id` | composite PK |
| `organization_id` | carried for the composite FKs below |
| `created_at` | |

This is the row PRD §5.3 will hang commission rates on.

Its tenant key references **`staff_profiles`**, not better-auth's `members`:
`(user_id, organization_id)` into `staff_profiles`, which already carries
`unique (user_id, organization_id)` from the staff feature. That is both the
available FK target and the more accurate one — it means "a staff member of
this salon", and it is the same table §5.3's performers card reads for the
branch assignment.

### 3.6 Cross-tenant rows are unrepresentable, not merely filtered

Both join tables carry `organization_id` and use **composite foreign keys** —
`(service_id, organization_id)` into `services`, `(team_id, organization_id)`
into `teams`, `(user_id, organization_id)` into `staff_profiles`.

An override pointing at another salon's branch cannot be stored at all, rather
than being something every query must remember to filter. This project has
shipped three cross-tenant leaks and caught a fourth on the wire; the
two-column key is cheap insurance on new tables.

**A composite FK needs a unique constraint on the columns it references, and
two of these targets do not have one today.** Verified against the live
database: `teams` and `members` each carry only `PRIMARY KEY (id)`.

- `teams` needs `unique (id, organization_id)` added. It is additive and
  redundant against the existing primary key, so it cannot reject a row
  better-auth would otherwise have written — it exists purely to be
  referenceable.
- `members` needs nothing, because §3.5 references `staff_profiles` instead.
  That avoids adding a `unique (user_id, organization_id)` to a
  library-owned table, which would be a real semantic change: it would forbid
  a second membership row that better-auth does not itself forbid.
- `services` and `service_categories` are ours and declare their own
  `unique (organization_id, id)`.

The migration touches a better-auth table exactly once, additively. If that
proves unacceptable in review, the fallback is application-level scoping plus
the §7.13/§7.14 assertions — weaker, because it relies on every future query
remembering.

### 3.7 `services` is a plan-capped resource, counting ACTIVE services only

Consistent with staff seats, and for the same reason: a retired service does
nothing for the salon.

This deliberately differs from branches, where a deactivated branch still
counts — there, freeing the slot would let a salon cycle branches to evade the
cap indefinitely. A retired service retains no such value.

## 4. Resolution

`resolveService(serviceId, teamId)` returns the effective `{ price, currency,
offered, durationMinutes }` for a service at a branch:

- `price` is `coalesce(override.price, service.price)`
- `offered` is `coalesce(override.offered, true)` and false when the service
  itself is inactive
- `currency` comes from `salon_profiles`

**Booking, POS and commission all call this one function.** If the coalesce is
copied inline in three places they will drift. `branch_entitlement` is the
precedent: a `security_invoker` view doing exactly this kind of resolution.

Returning the currency alongside the amount is deliberate — no caller can
format money without knowing which currency it is in.

## 5. Screens

All follow the `/branches` and `/staff` patterns: Server Actions,
`useActionState`, destructive `Alert` for errors, `disabled={pending}`,
Indonesian copy.

### 5.1 `/services`

Grouped by category, with remaining quota shown before "Tambah layanan".
Guarded by `service: ['update']` — owner and admin. Front desk and stylists
hold `service: ['read']` and are redirected; reading a price belongs to the
POS and booking screens, not to catalogue management.

### 5.2 `/services/new`

Name, category, duration, salon price.

### 5.3 `/services/[id]`

Three cards: the service itself; per-branch overrides; who may perform it.

**The overrides card** lists every branch with a price field and an "offered
here" toggle. An empty field means *inherits* and shows the salon price as a
placeholder. **The distinction between "inherits 150.000" and "overridden to
exactly 150.000" must survive the round trip** — otherwise a salon-wide price
change silently stops reaching that branch. This is the one place these screens
can quietly corrupt the model, so §7 asserts it directly.

**The performers card** lists staff who have a branch assignment. See §8.

### 5.4 Currency

Chosen at onboarding, defaulting to `IDR`. While the catalogue is empty, an
editable card on `/services` can change it; the moment a priced service exists
the card becomes a read-only line stating the currency and why it is fixed
(§2.6). That puts the control where its constraint is legible.

A full `/settings` screen is the better long-term home — `settings:
['read','update']` already exists in the permission statement — but it is a
worse use of this slice.

## 6. Error semantics

- **403** — front desk and stylists reaching the management screens redirect.
- **402** — creating past the tier's service cap. Deactivating frees a slot;
  reactivating re-consumes it behind the same quota check.
- **409** — a duplicate service name within the salon (case-insensitive);
  changing currency once a priced service exists.
- **Cross-tenant reads as not-found**, never as a leak — and for the join
  tables the database refuses the row outright (§3.6).

**Deliberately deferred:** deactivating a service that has future bookings
should be a 409. Bookings do not exist yet, so this is recorded as a constraint
the booking feature must add rather than a check invented against a table that
is not there.

## 7. Testing

`scripts/service-check.mjs`, matching the existing suites: no framework,
assert-and-count, **unconditional section-0 reset**. Nothing under `lib/` is
importable from a check suite — this project has been wrong about that twice —
so behaviour is driven through the dev server on port 3001.

Numbered assertions:

1. All five tables exist with RLS enabled.
2. The `salon_profiles` trigger seeds a row for a new organization; the
   backfill covered organizations that existed before the migration.
3. A duplicate service name in one salon is refused, case-insensitively.
4. Resolution with no override returns the salon price.
5. Resolution with an override returns the branch price.
6. `offered = false` hides the service at that branch; an inactive service is
   hidden everywhere.
7. **Inherits survives a round trip:** set a branch price equal to the salon
   price, then change the salon price, and assert that branch did not move.
8. Creating past the service cap returns 402 — proven by a creation that was
   refused succeeding after a deactivation, never by a count query.
9. Reactivating past the cap returns 402.
10. Currency is settable while the catalogue is empty and refused once a
    priced service exists.
11. `resolveService` returns the currency code alongside the amount.
12. A 0-exponent currency and a 2-exponent currency both round-trip and format
    correctly — this is where an integer/decimal confusion shows up as a 100×
    error.
13. The **database** refuses an override whose `team_id` belongs to another
    salon.
14. The database refuses a `service_staff` row whose `user_id` belongs to
    another salon.
15. A front-desk user and a stylist are each redirected away from `/services`.
16. Another salon's service id reads as not-found and leaks no name.

**Every load-bearing assertion gets break-and-restore evidence** — break the
production code, watch that specific assertion fail, restore, watch it pass.
Five assertions in this project have passed for the wrong reason; each was
caught only because someone broke the code and watched. The most recent was
vacuous because `FormData` normalised the input the test was trying to send.

**Pinned suites:** `auth:check` 70, `plan:check` 38, `ui:check` 16,
`branch:check` 44, `staff:check` 188 — all of them, including `plan:check`.

Corrected after checking the code: `services` is **already** in
`CAPPED_RESOURCES` (`lib/plan/catalog.ts`), the caps are already seeded
(free 10, starter 50, `scripts/seed-plans.mjs`), and `countResource` already
has a placeholder returning `null` for it, commented "services, products —
Task 9". So this feature fills in an anticipated hole rather than extending
the catalogue, and `plan:check` should not move.

If it does move, that is a signal to investigate — not to adjust the number.
Note that implementing the `services` branch means `requireQuota('services')`
starts enforcing where it previously no-opped on a null count; any plan:check
assertion that depended on the old no-op behaviour is a real finding.

## 8. Known limitation: working owners cannot be booked

The performers card lists staff who have a branch assignment. Owners and
admins have `team_id` null by the staff model, so **a working owner who cuts
hair cannot be linked to a service and will not be bookable.**

This is a real gap for small salons, where the owner is often the busiest
stylist. Fixing it properly means letting management hold a branch assignment
without becoming "assigned staff" for branch-deactivation purposes — a change
to the staff model, not a tweak here.

Deferred deliberately, to be decided when booking makes the cost concrete.

## 9. Known follow-ups

- **Working owners** (§8).
- **Commission rates** on `service_staff` (PRD §5.3).
- **Retail products** and the stock ledger (PRD §5.4).
- **A settings screen** to replace the currency card (§5.4).
- **Deactivating a service with future bookings** must become a 409 when
  bookings exist (§6).
- **Ownerless-salon race**, carried from staff management: two owners demoting
  each other concurrently still reach zero active owners. Recorded as a
  `ponytail:` comment in `app/dashboard/staff/actions.ts`.
