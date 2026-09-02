# Staff Scheduling — Design

**Date:** 2026-09-02
**Status:** approved
**Consumer:** the booking engine (PRD §5.1), which is specced separately

## 1. Goal

Answer one question, reliably: **when is this stylist available on this date?**

Booking computes slots from that answer. Nothing else in this slice matters
more than getting it right, because a wrong answer here is either a customer
booking a stylist who is not there, or a stylist sitting idle behind an empty
calendar.

### In scope

- `staff_hours` — the normal week, one interval per weekday
- `staff_schedule_exceptions` — this date is different (off, or different hours)
- `staff_time_off` — this window on this date is unavailable
- `staff_working_hours(...)` — the resolution, in the database
- A schedule card on the existing `/staff/[id]` screen

### Out of scope

- **Slot generation, the booking flow, the calendar.** This slice publishes the
  interface; booking consumes it.
- **Stylists editing their own schedule.** A separate permission question.
- **Recurring time off.** See §2.4 — recurring blocks are the signal that the
  weekly pattern should have gained intervals instead.

## 2. Decisions

### 2.1 One interval per weekday, mirroring `branch_hours`

`staff_hours` has the same shape as `branch_hours`: one row per staff per
weekday, with `closed`, `opens_at`, `closes_at`. Simple to store, simple to
edit, simple to reason about.

### 2.2 Three levers, each doing one thing

| Lever | Means | Shape |
|---|---|---|
| Weekly pattern | the normal week | one interval per weekday |
| Exception | this whole date is different | **replaces** that day |
| Time off | this window is unavailable | **subtracts** from that day |

An exception replaces, so it both removes a normal day and adds an unusual
one — a stylist covering a Sunday is the same operation as taking a Tuesday
off. Time off subtracts, so a midday gap needs no second interval.

**Where each is applied differs, and §4 depends on it.** The pattern and
exceptions are resolved by `staff_working_hours`, which answers "when is this
person working?". Time off is not: it is a busy period, applied by booking in
the same filter as existing appointments. Folding it into the function would
force that function to return windows — the exact shape §2.4 exists to defer.

### 2.3 A midday block produces two bookable windows, and that is fine

Blocking 13:00–15:00 inside a 09:00–21:00 day leaves two windows, and the
customer sees a gap. The split exists only in **computed** availability, never
in stored data.

Slot generation never materialises those windows: it generates candidates
across the interval and drops any overlapping a busy period. **A block and an
existing appointment are the same kind of busy period**, so that is one filter,
not two.

With intervals in the stored pattern instead, we would pay for the editing UI
*and* still write the same filter. Blocks buy the same visible outcome for only
the filter.

### 2.4 `staff_working_hours` returns a SET — binding constraint

**The resolution function returns a set of intervals, and every caller
iterates, even though it will only ever return zero or one row today.**

This costs nothing now — a query returning one row, a loop running once. It
exists so that adding multiple intervals per weekday later is a schema change
plus editing UI, with **no caller changes at all**. Slot generation, the piece
that carries the demo, never gets touched twice.

Do not "simplify" this to a single return before the option is spent. The
saving is a few characters; the cost is rewriting the booking engine's hot path
under time pressure.

The signal that the option should be spent: someone creating the *same* block
every week. Recurring time off means the pattern wanted intervals.

### 2.5 A new hire is bookable immediately

`staff_hours` is seeded by trigger when a `staff_profiles` row appears, with
the same defaults as `branch_hours`. An unconfigured schedule that silently
means "never appears in booking" is a failure nobody sees — the stylist simply
never gets booked, and no error is ever raised.

### 2.6 Branch hours are a ceiling, not a suggestion

Nobody works when the branch is shut, whatever their own schedule says, and a
stylist's hours are clamped to the branch's. Booking a customer into a closed
branch is worse than losing an edge-case hour.

## 3. Data model

Three tables. RLS enabled with zero policies, like every other table here.

### 3.1 `staff_hours`

| column | notes |
|---|---|
| `user_id`, `organization_id` | the staff member |
| `weekday` | `smallint`, 0 = Sunday, matching `extract(dow)` |
| `closed` | not null, default false |
| `opens_at`, `closes_at` | `time`, defaults `09:00` / `21:00` |

Primary key `(user_id, organization_id, weekday)`. Check `closed or closes_at >
opens_at`, matching `branch_hours`.

### 3.2 `staff_schedule_exceptions`

| column | notes |
|---|---|
| `user_id`, `organization_id` | |
| `on_date` | `date` |
| `closed` | not null, default true — the common case is a day off |
| `opens_at`, `closes_at` | nullable; required when not closed |
| `note` | nullable — "cuti", "training" |

Primary key `(user_id, organization_id, on_date)`: one exception per person per
date. Check `closed or (opens_at is not null and closes_at > opens_at)`.

### 3.3 `staff_time_off`

| column | notes |
|---|---|
| `id` | PK |
| `user_id`, `organization_id` | |
| `on_date` | `date` |
| `starts_at`, `ends_at` | `time`, not null |
| `note` | nullable |

Check `ends_at > starts_at`. Several per day allowed — two separate errands are
two blocks. Deliberately **not** unique per date.

### 3.4 Cross-tenant rows are unrepresentable

All three carry `organization_id` and use composite foreign keys
`(user_id, organization_id)` into `staff_profiles`, which already has the
matching unique constraint. The database refuses a cross-tenant row rather than
every query remembering to filter — the pattern the services join tables use.

## 4. Resolution

```
staff_working_hours(p_user_id text, p_organization_id text, p_date date)
  returns table (opens_at time, closes_at time)
```

In SQL, not TypeScript, for the reason `service_branch_pricing` is a view:
booking and the check suite then exercise **the same logic**, rather than the
tests re-implementing it and proving only that the copy works.

The rule:

1. Find the staff member's branch (`staff_profiles.team_id`). No branch → no
   rows. Owners and admins have none, so they are not bookable (a known gap
   carried from the staff spec §8).
2. `branch_hours` for that weekday. Branch closed → no rows (§2.6).
3. An exception for that date if one exists, else the weekly pattern. Either
   marked closed → no rows.
4. Intersect the staff interval with the branch interval. Empty → no rows.
5. Return the intersection, as a set (§2.4).

**Time off is deliberately not subtracted here.** This function answers "when is
this person working?"; blocks are busy periods, and booking already filters busy
periods for existing appointments. Folding them in would mean this function
returns windows, which is exactly the shape §2.4 exists to defer.

`staff_time_off` rows are read by booking alongside existing appointments,
through one query, and applied as one filter.

## 5. Screens

A card on `/staff/[id]`, below the existing ones, guarded by `staff: ['update']`
like every other write there.

- **Seven weekday rows** — closed toggle, opens, closes. Saved as one form,
  mirroring the branch hours card.
- **Exceptions** — upcoming dates listed with a note, an add form (date, closed
  or hours, note), and a remove action. Past exceptions are not shown; they are
  not deleted either, because a booking made under one is explained by it.
- **Time off** — same treatment: upcoming blocks with date and window.

Times use the same `time` inputs as the branch hours card. No timezone: the
salon and its customers are in one, decided in branch management.

## 6. Error semantics

- **403** — a stylist or front-desk user reaching the schedule card's actions.
- **409** — an exception for a date that already has one (one per person per
  date); a block whose window is inverted or zero-length.
- **Cross-tenant reads as not-found**, and the join tables refuse the row
  outright (§3.4).
- No 402: schedules are not capped.

## 7. Testing

Vitest against real Postgres — the whole feature is a resolution rule, so SQL
assertions cover it better than driving screens. The schedule card's guards and
form round trip go to Playwright.

The assertions that carry weight:

1. Branch closed on that weekday → no rows, whatever the staff pattern says.
2. Staff closed on that weekday → no rows.
3. No exception → the weekly pattern applies.
4. An exception replaces the pattern for that date only; the next week is
   unaffected.
5. An exception can **add** a day the pattern marks closed.
6. An exception marked closed → no rows.
7. The intersection clamps **both** ends — staff 08:00–22:00 against branch
   09:00–21:00 returns 09:00–21:00.
8. Disjoint intervals → no rows, not a negative-length one.
9. A staff member with no branch → no rows.
10. The trigger seeds seven rows for a new staff member; the backfill covered
    those that existed before the migration.
11. The database refuses an exception whose `user_id` belongs to another salon.
12. The database refuses a block with `ends_at <= starts_at`.
13. The function is genuinely set-returning — `pg_proc.proretset` is true for
    it. Asserted against the catalogue rather than inferred from a call that
    happens to yield one row, because a function returning a single row and one
    returning a set of one are indistinguishable at the call site, and §2.4's
    whole value is that callers already iterate.
14. A stylist and a front-desk user are each refused the schedule actions.

**Every load-bearing assertion gets break-and-restore evidence.** Seven
assertions in this project have passed for the wrong reason; each was caught by
breaking the code and watching, never by review. **The break must compile** — an
edit that fails the build fails the run without exercising anything.

Pinned: Vitest 96, Playwright 149 before this slice adds to them.

## 8. Known limitation, carried forward

Owners and admins have no branch assignment, so they cannot be scheduled and
will not be bookable. For a small salon whose owner is the busiest stylist that
is wrong, and it is recorded in the staff spec §8 as needing a staff-model
change rather than a patch here. Booking will make the cost concrete.
