# The Salon Landing Page — Design

**Date:** 2026-09-05
**Status:** draft
**Covers:** the public face of a tenant subdomain

## 1. The problem

`ovarya.atjelita.com` rewrites straight into the booking form. A visitor who
followed a link from Instagram lands on a date picker: no address, no opening
hours, no prices, no way to tell whether this is even the right salon.

That is the nicest link a salon can hand out, and today it is a form.

## 2. What this is

A shopfront. Name, logo, brand colour, where they are, when they are open,
what they charge — and booking one click away, never two.

**It needs no migration.** Every field already exists: `salon_profiles` has
the logo and brand colour, `branch_profiles` the address and phone,
`branch_hours` the week, and the priced menu comes from the same
`service_branch_pricing` view the booking page reads. That is the reason to
build this before the platform page, not merely first.

## 3. Routing

| URL | Today | After |
|---|---|---|
| `ovarya.atjelita.com/` | rewrites to `/book/ovarya` | rewrites to `/salon/ovarya` |
| `ovarya.atjelita.com/book` | rewrites to `/book/ovarya` | unchanged |
| `atjelita.com/salon/ovarya` | — | the same page, without a subdomain |

`/book` keeps working as a direct link, because a salon that wants to send
people straight to booking should still be able to.

## 4. What a stranger may see

`PublicBranch` today is `{ teamId, name, address }` and its comment explains
why: `staffCount` and `withinCap` are the salon's business, and props to a
client component are serialised into the RSC payload whether rendered or not.

A shopfront needs **phone and opening hours** as well. Those belong on a
shopfront — they are painted on the door — so the type widens to include them
and nothing else. The rule it is widening under, stated so the next addition
has to argue against it: *a field goes on PublicBranch only if a salon would
print it on their own signage.*

Staff names are NOT on the page. The booking flow names them once a service is
chosen; a public roster of who works where, with hours, is a different thing
and nobody asked for it.

## 5. The page

- **Hero** — logo, salon name, brand colour, and one primary action:
  *Pesan sekarang*.
- **Branches** — for each active branch: name, address, phone, and this week's
  hours. Today's line is emphasised, because "are they open now" is the
  question a visitor actually has.
- **The menu** — services grouped by category with duration and price.
  Prices are PER BRANCH (`service_branch_pricing`), so the menu belongs to a
  branch: one branch renders directly, several render the selected one with
  the others one click away.
- **Every service row is a booking link** — `/book?serviceId=…&cabang=…`, so
  choosing from the menu lands on the booking form with that choice already
  made. This is what "one click away" means; a landing page that only says
  "Book now" has added a step, not removed one.
- **Footer** — a quiet "Powered by Jelita" linking to the platform page. The
  only marketing on a salon's own page.

## 6. Decisions

**No new tables, and no new writable fields in v1.** A gallery, an "about"
blurb and social links are the obvious next asks, and all three need schema,
an upload path and a settings UI. Shipping the shopfront from data that is
already maintained means it is never stale; a gallery nobody fills is worse
than no gallery.

**Branch selection uses the same `?cabang=` parameter and the same
resolution** the booking page uses. Not a second lookup: `lib/salon.ts`
already refuses a branch belonging to another salon, and that check exists
because a first cut of the booking page did not have it.

**A missing salon 404s exactly as booking does** — no "this salon is not
accepting bookings", which would turn the 404 into a directory of which salons
exist.

## 7. Metadata

`generateMetadata` gives the page the salon's name as its title and the
address as its description. A link pasted into WhatsApp currently previews as
"Jelita Salon Suite"; it should preview as the salon.

## 8. Testing

1. The subdomain root serves the landing page, not the booking form.
2. `/book` still serves the booking form.
3. The page shows the address, phone, today's hours and at least one price.
4. A service row links into booking with that service preselected.
5. A second salon's subdomain shows that salon — asserted on content.
6. `?cabang=` naming another salon's branch is refused, as on the booking page.
7. An unknown slug 404s.
8. The page carries no staff names and no internal fields.
9. It renders on a phone with no horizontal overflow.

**Break-and-restore evidence for each**, and the suite runs against a real
tenant hostname (`<slug>.localhost`), as `public-booking.spec.ts` already does
— a suite that only used the path form would pass with the rewrite deleted.
