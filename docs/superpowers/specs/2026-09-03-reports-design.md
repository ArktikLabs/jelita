# Reports & Analytics — Design

**Date:** 2026-09-03
**Status:** draft
**Covers:** PRD §5.6 (P1) and Flow C, and replaces the `/dashboard` stub

## 1. Goal

§5.6, in full: revenue for today/this week/this month with a trend, top 5
services by revenue and by volume, staff performance, the booking funnel, a
date-range filter, and CSV export.

Every input already exists — the transaction ledger, `commissions`, `bookings`
and `stock_on_hand`. **This slice adds no write path.** It is the first one
that only reads, which is why it is last: nothing else is going to change
shape underneath it.

### In scope

- One date range, with today/week/month presets
- Revenue, with a per-day trend
- Top 5 services, by revenue and by volume
- Staff performance: revenue, services, commission
- The booking funnel: total, completion rate, no-show rate
- Low stock (Flow C's fourth step)
- CSV export
- `/dashboard` itself, which is currently a stub

### Out of scope

- **PDF export.** §5.6 says post-MVP by name.
- **Cross-branch consolidation.** §5.8: "no consolidated cross-branch UI yet".
  Reports are scoped to the active branch, like every other screen.
- **A charting library.** See §2.5.

## 2. Decisions

### 2.1 `/dashboard` is everyone's landing page, so reports are a SECTION

`app/dashboard/(shell)/page.tsx` has no permission guard today, and it must
not gain one: it is where every role lands after signing in, and `report` is
held by owner and admin alone.

So the page renders **the same analytics, scoped to the viewer**:

| Holds | Scope |
|---|---|
| `report:['read']` | the branch — every stylist, every sale |
| `commission:['read:own']` only | themselves — their revenue, their services, their commission, their no-show rate, their trend |

Not a different page and not a lesser one. A stylist gets §5.6's sections
answering the same questions about their own work, which is the useful version
of "what does the dashboard show me".

**Mechanically this is one optional filter, not a second set of queries.** Every
function in `lib/reports.ts` takes `staffUserId?: string | null`; when it is
set, the joins narrow to that stylist's lines and bookings. Two query sets over
the same rows would be two chances to disagree, and the one a stylist saw would
be the one nobody checked.

Two figures are deliberately **absent** from the scoped view rather than scoped:
salon revenue in the KPI tiles (a stylist's own is shown instead) and low
stock, which is not theirs to act on.

This is the only screen in the product whose *content* varies by role rather
than its access.

### 2.2 One date range; the presets are just ranges

§5.6 asks for "today, this week, this month" **and** a date-range filter.
Those are the same query with different bounds, so there is one query and the
presets are links that set `from` and `to`.

Bounds are inclusive of `from` and exclusive of `to + 1 day`, matching how
every other range in this codebase reads `completed_at`.

### 2.3 Revenue needs no reversal clause. Volume does.

Money nets out for free: a reversal's `total` is negative, so
`sum(total)` over non-open rows is revenue. That property has been paid for
three times over.

**Counts do not.** A reversal's line carries a negative `unit_price` and a
**positive** `quantity`, because quantity is what was performed. So
`sum(quantity)` would count a voided service twice — once performed, once
returned — and "top services by volume" would rank a heavily-voided service
highest.

Volume is therefore `sum(quantity)` signed by `reverses_id`, exactly as stock
movements and points are. Stated here because it is the one place in this slice
where the obvious query is wrong.

### 2.4 The funnel counts bookings by their CURRENT status

`total`, `completed / total`, `no_show / total` over bookings whose `starts_at`
falls in the range.

By `starts_at`, not by when the booking was made: "what happened to last
week's appointments" is the question an owner is asking, and a booking made in
March for a June slot belongs to June.

Cancelled bookings stay in the denominator. A cancellation is an outcome, and
hiding it would flatter the completion rate.

### 2.5 Charts use Recharts, and the forms are chosen before the colours

**Recharts 3.10** — React 19 in its peer range, and the hover layer a chart is
expected to have comes with it rather than being hand-rolled.

The forms follow from what each figure's job is, not from wanting a chart:

| Figure | Form | Why not something else |
|---|---|---|
| Revenue today / week / month | **KPI tiles** | a one-bar bar chart is a number wearing a costume |
| Revenue over the range | **line**, single series | trend over time |
| Top 5 by revenue, and by volume | **horizontal bars** | magnitude, and Indonesian service names are long |
| Staff performance | **table** | three measures per person is a table, not a chart |
| Funnel | **KPI tiles** with the two rates | three numbers |
| Low stock | **table** | a list of names and counts |

Every chart is a **single series**, which settles the colour question: one
sequential hue (blue — `#2a78d6` light, `#3987e5` dark), and **no legend**,
because the title names the only series. Both steps pass the palette
validator's lightness, chroma and contrast checks in their own mode.

Consequences worth stating: the charts are **client components** (a chart needs
the DOM), so their data crosses the RSC boundary — which is fine, it is the
same aggregates already on screen. Dark mode gets its own step rather than an
automatic flip. Bars carry direct value labels, so the numbers survive for
anyone who cannot separate the mark from the surface.

No dual-axis chart anywhere. Revenue and count are different scales and get
different charts.

### 2.6 CSV export is a route handler, guarded separately

`report:['export']` is a distinct statement from `read`, and this uses it:
`/api/reports/csv?section=…&from=…&to=…`.

A route rather than a Server Action, because an action cannot hand the browser
a file — and the sandbox in the artifact viewer aside, a `Content-Disposition`
download is what a spreadsheet-bound owner expects.

Values are quoted and internal quotes doubled. A service named
`Smoothing, "Premium"` must not become three columns — and the demo seed's
Indonesian names contain commas often enough that this is not hypothetical.

## 3. Data model

**None.** Every figure comes from existing tables. The queries live in
`lib/reports.ts`.

## 4. Screens

- **`/dashboard`** — §2.1's role-dependent page. For an owner: the range
  picker, revenue with its trend, top services, staff performance, the funnel,
  and low stock.
- **`/api/reports/csv`** — one section per request.

Existing screens already cover Flow C's later steps: staff performance links
to `/dashboard/commissions`, low stock to `/dashboard/products`.

## 5. Testing

Vitest against real Postgres, all in `tests/reports.db.test.ts`:

1. Revenue sums the range and excludes anything outside it.
2. A void reduces revenue without any reversal clause in the query.
3. Top services by revenue ranks on money, by volume on **net** count — a
   voided sale must not inflate either.
4. Staff performance attributes to the line's `staff_user_id`, and a product
   line (which has none) does not appear.
5. Commission per staff matches `commissionRecap` for the same window — two
   queries over the same rows must not disagree.
6. The funnel counts by `starts_at`, keeps cancellations in the denominator,
   and reports 0 rather than dividing by zero on an empty range.
7. Every figure is scoped to the branch and the salon.
8. CSV quotes a value containing a comma and doubles an internal quote.

Playwright:

9. An owner sees revenue, top services, staff performance and the funnel; the
   numbers match the seeded data.
10. A stylist lands on the same URL and sees the same SECTIONS scoped to
    themselves: their own revenue and commission, their own top services, and
    a funnel over their own bookings — while the salon-wide revenue tile and
    low stock are absent.
10b. A stylist's scoped figures do not equal the branch's — asserted with a
    second stylist holding sales, so "scoped" cannot pass by there being only
    one person.
11. The CSV download has a `Content-Disposition` filename and a header row.
12. A role without `report:['export']` is refused the CSV route.

**Every load-bearing assertion gets break-and-restore evidence.**
