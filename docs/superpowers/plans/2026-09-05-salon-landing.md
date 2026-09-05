# The Salon Landing Page — Implementation Plan

**Spec:** `docs/superpowers/specs/2026-09-05-salon-landing-design.md`
**Date:** 2026-09-05

Three steps. Each ends green with break-and-restore evidence, committed BEFORE
breaking (tests/README.md).

---

## Step 1 — the query layer

Widen `PublicBranch` with `phone` and `hours`, and add `salonMenu(orgId,
teamId)` for the priced, categorised menu.

⚠️ `bookableServices` in `lib/booking.ts` already returns the priced list for a
branch. Read it before writing anything: if it serves, the menu is a grouping
in the page and not a new query. Two queries over
`service_branch_pricing` that disagree is exactly the bug the view exists to
prevent.

**Break evidence:** return an inactive branch; return a branch of another
salon; drop the category grouping.

## Step 2 — the page and the rewrite

`app/salon/[salon]/page.tsx`, plus the `/` host rewrite pointed at it.

⚠️ The rewrite change is the risky part. `/` on a tenant host currently goes
to `/book/:salon`; both rules live in `beforeFiles` and the ORDER matters. Get
this wrong and either the apex marketing page or every salon subdomain breaks,
and the e2e for public booking is what will say so.

⚠️ Prices come from the branch. With no `?cabang=`, pick the first active
branch — and say so on the page, or a two-branch salon silently advertises one
branch's prices as though they were the salon's.

**Break evidence:** point the rewrite back at `/book`; drop the `?cabang=`
validation; hide the branch name from the menu heading.

## Step 3 — metadata, mobile, merge

`generateMetadata`; then look at it on a phone, which is where §8 of the PRD
says these customers are.

Then: full suites, screenshot, merge.

---

## Known risks

**The rewrite is shared with the booking page.** `public-booking.spec.ts`
covers `/book` on a real subdomain; run it after touching next.config.ts, not
at the end.

**`/salon/[salon]` must not shadow anything.** `app/` already owns `/book`,
`/dashboard`, `/login`, `/register`, `/api`. `salon` is free, but check the
build output for a route collision rather than assuming.
