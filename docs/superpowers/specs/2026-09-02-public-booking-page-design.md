# Public Booking Page — Design

**Date:** 2026-09-02
**Status:** draft
**Depends on:** the booking engine (`available_slots`, `lib/booking.ts`,
`bookings_no_overlap`), which this slice drives from the outside

## 1. Goal

A customer with no account books an appointment at
`ovarya.atjelita.com/book`.

The engine already answers every hard question — when a stylist is free, and
who wins a contested slot. This slice is about **letting a stranger reach it
safely**: resolving which salon a hostname means, and exposing exactly one
write to the open internet without handing it anything the app trusts.

### In scope

- Subdomain → salon resolution, and where it is *validated*
- The public page: branch (when there is a choice), service, stylist, date,
  slot, name, WhatsApp number
- A confirmation view
- Onboarding slug validation, now that a slug is a hostname
- A per-phone daily cap on the one anonymous write

### Out of scope

- **Customer cancellation from a link.** Decided against for now: it needs a
  token and a second public mutation. The salon cancels from `/dashboard/bookings`.
- **Customer accounts and loyalty.** Unchanged from the engine spec §2.7 — the
  phone stays the durable identity, and this page is the reason it must not
  require an account.
- **Per-branch vanity URLs** (`/book/kemang`). See §4.3.
- **The admin calendar and walk-ins.** Still the slice after this.

## 2. Decisions

### 2.1 A host rewrite in `next.config.ts`, not `proxy.ts`

```ts
{ source: '/book/:path*',
  has: [{ type: 'host', value: '(?<tenant>[^.]+)\\.<apex>' }],
  destination: '/book/:tenant/:path*' }
```

`has: [{ type: 'host' }]` is first-class (`RouteHas` in
`next/dist/lib/load-custom-routes.d.ts`), so the tenant arrives as an ordinary
route param on `app/book/[salon]/page.tsx`. No new runtime layer and nothing
added to the request path.

**Deliberately not `proxy.ts`.** Next 16's own proxy reference warns that
Server Functions are POSTs to the route they live on, so *"a matcher change or
a refactor that moves a Server Function to a different route can silently
remove Proxy coverage — always verify authentication and authorization inside
each Server Function rather than relying on Proxy alone."* That is exactly the
failure mode this project keeps finding, and a guard that a refactor can
silently delete is worse than no guard, because it reads as one.

The apex domain comes from an env var so dev (`ovarya.localhost:3001`), test
and production share one rule rather than three.

### 2.2 The hostname is routing. It is never authorization.

The subdomain says which salon to **look up**. It proves nothing. One lib
function resolves `slug → organization` and every page and action calls it,
the way `provisionStaff` and `lib/booking.ts` are single authorities.

A consequence, accepted: `atjelita.com/book/ovarya` reaches the same page,
because any app route is routable. Harmless — the page is public either way —
and closeable later with a Host comparison if a canonical URL matters.

### 2.3 The dashboard stays on the apex

`atjelita.com/dashboard`, `ovarya.atjelita.com/book`.

**The public page is anonymous — it needs no session at all**, so the tenant
subdomain never needs a cookie. That removes the entire cookie-domain problem:
no wildcard `Domain=.atjelita.com`, no better-auth `baseURL` juggling, and no
session readable across every tenant hostname.

Moving the dashboard onto subdomains buys the *feel* of tenancy and costs a
shared auth cookie across all of them. Not a trade worth making for a demo,
and not one that is hard to revisit.

On a tenant subdomain, `/` redirects to `/book` and everything else redirects
to the apex.

### 2.4 A slug is now a hostname

Onboarding validates `^[a-z0-9-]+$`
(`app/dashboard/onboarding/actions.ts:26`). As a DNS label that leaves three
holes, all of which become real the moment a slug is a subdomain:

| Hole | Why it matters |
|---|---|
| reserved names | `www`, `app`, `api`, `admin`, `mail` would each become a bookable salon |
| leading/trailing hyphen | not a legal DNS label |
| over 63 characters | over the label limit |

An **allow-list of characters plus a deny-list of reserved names** — the
character rule already exists and only the shape checks are new. Existing slugs
are test fixtures, so no migration.

### 2.5 The branch step appears only when there is a choice

Branch caps are a plan property: free and starter get 1, pro 3, business
unlimited (`scripts/seed-plans.mjs:22`). So a single-branch salon and a
multi-branch one are both normal, and "just use the first branch" is wrong for
half the tiers.

- **One bookable branch** → no step. The customer goes straight to services.
- **More than one** → a branch step first, because `available_slots` cannot be
  called without a `team_id`.
- **None** → "not accepting bookings right now" (§6).

**Bookable means active AND within cap.** A salon that downgrades from Pro to
Free keeps three branches against a cap of one, and the two over-cap branches
are read-only — `listBranches` already carries `withinCap` for exactly this. A
customer booking into a branch the salon cannot operate is a worse failure than
not showing it.

### 2.6 The customer's choice is validated against the resolved salon

The branch arrives as `?cabang=<teamId>` and is checked against that salon's
bookable branches before it reaches `available_slots`. Not trusted, ever.

This is the same guard added to `createBookingAction` this week — where it was
belt-and-braces, since the poster already held a session. Here it is the actual
tenant boundary, and it is the one line that stops
`ovarya.atjelita.com/book?cabang=<some other salon's branch>`.

The composite foreign keys make a cross-tenant booking unrepresentable anyway
(engine spec §3.4), so the failure mode is a refusal, not corruption. The check
turns that refusal into "not found" instead of a constraint error.

### 2.7 Public bookings land `pending`

The salon confirms. That is PRD §5.1's lifecycle and the reason `pending` holds
the slot (engine spec §2.2): a slot a stranger claimed must not be resold
before anyone has looked at it.

### 2.8 One anonymous write, one cap

This is the first endpoint on the product that writes rows without a session:
a booking, and a customer row via `findOrCreateByPhone`.

better-auth's rate limiting does not cover it — process-wide, in-memory, and
production-only by default. So: **a per-phone, per-salon, per-day cap**,
enforced in the database where the count is authoritative.

Deliberately **not** in `createBooking`: the front desk routes through the same
function and must never be capped. It belongs in the public action alone.

The cap is not anti-abuse in any serious sense — it stops a bored script, not a
determined one. Naming that ceiling is the point; the real answer is a captcha
or WhatsApp verification, and neither is in this slice.

## 3. What the page shows

Two phases, both plain forms, mirroring the internal form so `createBooking`
stays the single authority:

1. **GET** — branch (when there is a choice), service, stylist or "any
   available", date. Re-renders with the slots for that combination.
2. **POST** — the chosen slot, name, WhatsApp number.

Then a confirmation view: branch, service, stylist, date and time, and "the
salon will confirm via WhatsApp." **No reference code** — nothing generates one
today, and the salon finds the booking by phone. Adding a column for a number
nobody can act on is not worth it while there is no cancel link.

### 3.1 What must not reach the browser

`listBranches` returns `staffCount` and `withinCap`. Neither is the public's
business, and props to a client component are serialized into the RSC payload
whether rendered or not — the bug already fixed once in the app shell's branch
switcher. The public page passes a name, an address and an id, and nothing else.

Prices, service names, stylist names and branch addresses are all deliberately
public. That is what a booking page is.

## 4. Deliberately deferred

### 4.1 Canonical host
`atjelita.com/book/ovarya` works as well as the subdomain (§2.2).

### 4.2 Branch vanity URLs
`?cabang=<teamId>` is shareable, if ugly. `/book/kemang` needs a slug column on
branches; worth it when a salon wants to put a branch link on Instagram, not
before.

### 4.3 Serious abuse control
§2.8's ceiling.

## 5. Testing

Vitest against real Postgres, for the resolution rules:

1. An unknown slug resolves to nothing.
2. A slug resolves to exactly one salon, and never to another tenant's.
3. Bookable branches exclude the inactive **and** the over-cap — asserted by
   downgrading a plan, not by editing `withinCap` directly.
4. A salon whose every branch is closed offers no branches at all.
5. The per-phone daily cap refuses the (n+1)th and leaves nothing written.
6. The reserved-name and DNS-shape rules refuse `www`, `-ovarya`, `ovarya-`
   and a 64-character slug, and accept a normal one.

Playwright, through a real browser on a real subdomain host:

7. `ovarya.localhost:3100/book` renders that salon's services, and a different
   salon's subdomain renders different ones.
8. The full flow books a slot, and the slot stops being offered.
9. A single-branch salon never sees the branch step; a multi-branch one does.
10. `?cabang=` naming another salon's branch is refused, not booked.
11. The booking lands `pending` and appears on that salon's `/dashboard/bookings`.
12. An unknown subdomain 404s rather than leaking which salons exist.

**Every load-bearing assertion gets break-and-restore evidence.** Nine
assertions in this project have now passed for the wrong reason; every one was
caught by breaking the code and watching, never by review. **The break must
compile.**
