# Payroll — Design

**Date:** 2026-09-03
**Status:** implemented
**Covers:** PRD §5.9 (P2)

## 1. Goal

§5.9, in full: *"Payroll recap = base salary + commission + deductions per
staff per month; no attendance/leave in MVP."*

Commissions already exist and are immutable. This slice adds the two numbers
either side of them and the screen that puts all three together.

### In scope

- A monthly base salary per staff member
- Ad-hoc deductions, per staff per month
- The recap: base + commission − deductions, per staff per month

### Out of scope

- **Attendance and leave.** §5.9 excludes them by name.
- **A separate payroll RUN step.** Closing a month snapshots and freezes it in
  one action (§2.5b), guarded by `payroll:['lock']`. `payroll:['run']` stays
  unused: a run earns its place when there are payslips to produce and review
  before payment, and with nothing to produce it would be the same button with
  two names.
- **Payslip documents.** The recap is a screen; a PDF per staff member is
  post-MVP, and the receipt's print stylesheet is the pattern when it lands.
- **Proration.** Someone who joins mid-month gets the whole base. Real
  payroll prorates; a demo does not, and the alternative is a start-date field
  and a rule about part-months that nobody has asked for.

## 2. Decisions

### 2.1 Base salary lives on `staff_profiles`, and is nullable

Nullable is the point: **commission-only staff are normal**, especially in
Indonesian salons, and a base of zero is a different statement from "this
person has no base". Zero says "salaried at nothing"; null says "not salaried".
The recap shows a dash for null and `Rp 0` for zero, and an owner setting one
by accident should be able to tell.

### 2.2 Deductions are rows, not a column

Several per month is the normal case — a uniform, a product taken home, an
advance against next month. One column per staff per month would force the
front desk to add them up by hand, which is the spreadsheet this feature
exists to replace.

Each carries a note and who recorded it, so a stylist asking "what is this
Rp 50.000" has an answer.

### 2.3 A month is a date, and the first of it

`month` is a `date` constrained to `day = 1`. Not a string like `'2026-09'`:
a text month sorts correctly by luck, cannot be compared with a range, and
puts the parsing in every query that touches it.

### 2.4 Closing a month freezes it — the limitation below, closed

The recap is computed on read: base + the month's commissions − the month's
deductions.

Commissions are immutable, so that half cannot drift. **Deductions can be
edited after the fact**, which means the recap for a month somebody was already
paid for can change. That is exactly the class of problem `transactions`'
immutability trigger exists to prevent.

The fix is a payroll *run*: snapshot the figures, freeze the month, and let a
correction be a new adjustment rather than an edit — which is what
`payroll: ['run', 'lock']` are reserved for. It is not in the MVP because §5.9
asks for a recap, and a run without a payslip to produce is machinery with no
output.

**This was left open and is now fixed** (§2.7). Recorded as written, because
the reasoning is why the fix looks the way it does.

### 2.5b Closing a month snapshots it and freezes its inputs

One action, `payroll:['lock']`: it writes a `payroll_runs` row with a line per
staff member — base, commission, deductions and net **as they stood** — and
from then on the recap for that month reads the snapshot rather than
recomputing.

`payroll:['run']` stays unused, and that is deliberate rather than an
oversight. A separate "run" step earns its place when there are payslips to
produce and review before payment; with nothing to produce, run and lock would
be the same button with two names.

**Deductions for a closed month are refused by a trigger**, not by the action:
the recap reads a snapshot so an edit would no longer change the number, but it
would still change what `listDeductions` shows beside it, and a stylist
querying a payslip would find the screen disagreeing with the paper.

**A closed month does not reopen.** That is the accounting answer, not
laziness: a correction belongs in the next month, where it is visible as a
correction, rather than silently altering a period that has been paid and
reported. Reopening is refused with the same trigger.

## 3. Data model

### 3.1 `staff_profiles.base_salary`

`bigint`, nullable, minor units. Check: null or ≥ 0.

### 3.2 `payroll_deductions`

`id`, `organization_id`, `user_id`, `month` (date, day = 1), `amount`
(minor units, > 0), `note`, `actor_user_id`, `created_at`.

Amount is positive and the recap subtracts it — a signed column would let a
"deduction" quietly become a bonus, and a bonus is a different feature with a
different conversation behind it.

Composite foreign key `(user_id, organization_id)` into `staff_profiles`, as
everywhere else.

## 4. Screens

**`/dashboard/payroll`** — a month, and a row per active staff member: base,
commission earned, deductions, net. Guarded by `payroll: ['read']`, which
owner and admin hold and nobody else does.

Deductions are added from the same page and removed while the month is open —
which, per §2.4, is always, and is the limitation named above.

Base salary is edited on `/dashboard/staff/[id]`, beside the role and branch
cards it belongs with.

## 5. Testing

Vitest against real Postgres:

1. The recap is base + commission − deductions, per staff per month.
2. Commission comes from the month the sale COMPLETED, not the month it is
   read in.
3. A voided sale reduces the commission half — the ledger property, again.
4. A staff member with no base salary shows as null, not zero.
5. Deductions from another month are not subtracted.
6. A deduction of zero or less is refused.
7. A month that is not the first of a month is refused.
8. Another salon's staff never appear.

Playwright:

9. Setting a base salary on a staff member shows it in the recap.
10. Adding a deduction lowers the net; removing it restores.
11. Front desk and stylists are refused the page entirely.
12. Closing freezes the figures: a base salary changed afterwards does not
    move them, and neither the deduction form nor the remove button is offered.
13. The deduction endpoint refuses a closed month even when the form's fields
    are posted from before the close — the stale-tab case.

### 5b. What the breaks caught

- **A void books into the month it HAPPENS, not the month of the sale.** The
  assertion was first written as "voiding gives the commission back", and it
  failed: September kept its 40,000 and the reversal landed in the current
  month. That is correct — a reversal is an event now, and reopening a month
  somebody was already paid for would be worse than leaving the adjustment
  where it belongs. It also softens §2.4: a past month's total cannot be
  rewritten by a void, only by editing a deduction.
- **A guard no role could falsify.** Swapping the base-salary guard from
  `payroll:['read']` to `staff:['update']` failed nothing, because owner and
  admin hold both and nobody else holds either. `tests/permissions.test.ts`
  now asserts the fact that makes them interchangeable — no built-in role
  holds `staff:update` without `payroll:read` — which fails the moment one
  does, and the guard starts to matter. Granting front desk `staff:update`
  fails it.

**Every load-bearing assertion gets break-and-restore evidence.**
