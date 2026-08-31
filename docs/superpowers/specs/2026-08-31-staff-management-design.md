# Staff Management — Design

**Date:** 2026-08-31
**Status:** approved for planning
**Predecessor:** `2026-08-30-branch-management-design.md`

## 1. Goal

Let a salon owner or admin run their roster: see who works where, add a new
hire, move someone between branches, change a role, reset a forgotten
password, and record a departure — with the plan's seat cap enforced
throughout.

### In scope

- `/staff` list, filterable by branch
- `/staff/new` — add one staff member
- `/staff/[id]` — role, branch transfer, password reset, deactivate/reactivate
- `/staff/import` — bulk creation from a pasted or uploaded file
- A change to **shipped branch code**: branch deactivation switches from the
  `isStaff` role filter to `staff_profiles` (§3.3), retiring the deny-list.
  `branch:check`'s existing assertions must keep passing across that swap.

### Out of scope

- Shifts, rosters and scheduling. Multi-branch **cover** belongs there, not
  here (see §2.1).
- Commission rates, payroll and employment attributes beyond assignment and
  status.
- Self-service profile editing — **already shipped**. `updateProfileAction`,
  `changePasswordAction` and session revocation exist at `/profile` from the
  auth-screens slice and need no work here.
- Email invitations. better-auth's invitation flow works in the backend and
  stays available, but it is not a surface in this slice (§2.3).
- Permanently deleting a staff member. Deactivation is the exit path.

## 2. Decisions carried in

These were settled in brainstorming and bind the whole feature.

### 2.1 One branch per staff member

A staff member is assigned to exactly one branch, enforced by
`unique (user_id, organization_id)` in the schema rather than by application
code.

Occasional cover at another branch is a **scheduling** concept and is
deliberately deferred. Modelling cover as permanent dual membership would
make the covering stylist part of the other branch's headcount forever, and —
given branch deactivation refuses to close a branch with staff assigned —
would make that branch harder to close for a person who worked there once.

### 2.2 Work records carry their own `branch_id` — binding constraint

**Every future record of work — a booking, a commission line, a payroll entry
— stores the branch it happened at. None of them derives the branch from the
staff member who performed it.**

This is the constraint that keeps multi-branch cover affordable later. If
work records infer their branch from the person, then enabling cover is not a
refactor: every historical record becomes ambiguous, and which location a past
appointment happened at cannot be reconstructed after the fact. That is
uncapturable data, not deferred work.

This constraint binds features that do not exist yet. It is recorded here
because this is the spec that creates the temptation.

### 2.3 The owner sets the password

Staff are provisioned directly: the owner types a name, email, role, branch
and starting password, and the login works immediately.

PRD §3 onboards therapists at the front desk and notes many have no working
email, so an invitation-only flow could not onboard them. The mail transport
is currently `.mail.log` (`lib/notify.ts`), so invitations would not reach
anyone regardless.

The consequence: the self-serve forgot-password flow can never reach these
users, which is why owner-initiated password reset (§5.3) is core rather than
optional.

### 2.4 Deactivation frees the seat

A deactivated staff member releases their plan seat. Reactivation re-consumes
it and is subject to the same quota check as hiring.

This differs deliberately from branch deactivation, which does **not** free a
slot. The asymmetry is intentional: staff turnover is a normal lifecycle
event, and a seat cap that never releases would become a lifetime hiring
limit — a salon with ordinary turnover would be paying for ex-employees
within a year and would have to contact support to hire anyone. Branch
cycling, by contrast, would let a salon accumulate unlimited branch records
under a cap of one.

## 3. Data model

### 3.1 `staff_profiles`

One row per member per salon, named and built to match `branch_profiles`.

| column | type | notes |
|---|---|---|
| `user_id` | text | FK → `users.id`, cascade |
| `organization_id` | text | FK → `organizations.id`, cascade |
| `team_id` | text null | the branch; **null** for owner and admin |
| `active` | boolean not null default true | `false` = left the salon |
| `deactivated_at` | timestamptz null | |
| `created_at`, `updated_at` | timestamptz not null | |

- `unique (user_id, organization_id)` — enforces §2.1.
- `team_id` FK → `teams.id`, and the branch must belong to the same
  organization (§6.3).
- RLS enabled with zero policies, matching every other table here: the app
  connects as owner and bypasses.
- Seeded by an **insert trigger on `members`** plus a **backfill** for
  existing rows — the same mechanism migration `0008` uses for branches.

### 3.2 Every member gets a row, including the owner

The seat cap counts `members` rows today (`lib/plan/entitlements.ts:97-99`),
so the owner already consumes a seat. If only assigned staff had profiles,
owners and admins would silently stop counting and every salon's effective
seat allowance would increase.

`countResource('staff')` therefore changes from counting `members` to counting
members whose profile is `active`. The owner keeps their seat; a departed
stylist releases theirs.

### 3.3 Relationship to `team_members`

`team_members` keeps its existing, purely **navigational** meaning: the
session hook reads it to resolve `activeTeamId` on login
(`lib/auth.ts:108-122`), and `setActiveTeam` refuses a user with no row.

`staff_profiles` is the sole authority on **who works where**. Branch
deactivation consults it and no longer inspects roles at all, which retires
the `isStaff` deny-list and the custom-role hole it leaves open
(`dynamicAccessControl` is enabled, so a future `manajer` role would otherwise
count as staff and make a branch undeactivatable).

Creating a branch-assigned staff member therefore writes **two** rows: the
profile, and the `team_members` row that lets them land in a branch on login.
A single module (`lib/staff.ts`) owns that pair, and §7.7 asserts they never
drift.

## 4. Roles and assignment

| role | branch assignment | staff permissions |
|---|---|---|
| `owner` | none (`team_id` null) | all |
| `admin` | none (`team_id` null) | all |
| `frontdesk` | **required** | none |
| `stylist` | **required** | none |

`frontdesk` holds `branch: ['read']` with no `switch`, so an unassigned
front-desk user would have nowhere to be. Owners and admins are salon-wide
and switch freely.

Because assignment follows role, **changing a role changes the assignment**:
promoting a stylist to admin clears `team_id`; demoting an admin to stylist or
front desk requires choosing a branch in the same form.

## 5. Screens

All follow the `/branches` patterns: Server Actions, `useActionState`,
destructive `Alert` for errors, `disabled={pending}`, Indonesian copy.
Guarded by `staff: ['read']`, which only owner and admin hold — so there is no
partial-visibility case.

### 5.1 `/staff` — list

Name, email, role, branch, status. Filterable by branch. Scoped by
`organization_id` in the same query that reads it.

### 5.2 `/staff/new`

Name, email, password, role, branch (shown only for `stylist` and
`frontdesk`). Calls the shared provisioning function (§8).

### 5.3 `/staff/[id]` — detail

Four operations:

- **Change role** — with the assignment consequence from §4.
- **Transfer branch** — subject to §6.3.
- **Reset password** — the owner sets a new one directly. **Revokes that
  user's existing sessions**, or the reset does not lock out whoever prompted
  it.
- **Deactivate / reactivate** — deactivation revokes sessions and frees the
  seat; reactivation re-consumes it behind `requireQuota('staff')`.

### 5.4 `/staff/import` — bulk creation

Columns: name, email, password, role, branch name.

A row's branch column follows §4: required for `stylist` and `frontdesk`, and
must be empty for `owner` and `admin`. A management row naming a branch is a
validation error, not a silently ignored value. Passwords are subject to the
configured `minPasswordLength` of 8 (`lib/auth.ts:41`), checked per row during
validation rather than at creation.

**Validate everything, then commit.** The file is fully checked first — every
field, every branch name resolved, duplicate emails within the file, emails
already taken, and whether the total exceeds remaining seats. If anything
fails, **nothing is created** and the report lists every bad row at once.

The page shows remaining seats before a file is chosen ("Sisa kuota staf: 6
dari 25"), so the constraint is visible while deciding what to paste.

There is **no preview-and-confirm step**: in the happy path it only ever says
yes, and the failure path already reports everything with nothing written.

**Sequencing:** import is the heaviest item here and nothing else depends on
it. The plan sequences it last so it can be dropped under schedule pressure
without disturbing the rest of the feature.

## 6. Error semantics

Applying the codes already established in this codebase.

### 6.1 403 — the role lacks permission

Includes an admin attempting to deactivate or demote an **owner**.

### 6.2 402 — the tier is the blocker

Hiring, rehiring, or an import needing more seats than remain — one 402
naming the shortfall, never a partial import.

Also **assigning staff to a locked branch**: a locked branch is read-only
because of the tier, so the remedy is an upgrade.

### 6.3 409 — a conflict the salon created

- Email already taken.
- Assigning to a **closed** branch — remedy is reactivate, not upgrade.
  When a branch is both closed and locked, **closed wins**, matching
  `getBranchStatus`'s existing ordering.
- Assigning to a branch belonging to another salon reads as not-found, never
  as a leak of that branch's existence.
- **The last owner cannot be deactivated.**
- **An owner cannot deactivate themselves.**

The last two prevent a one-owner salon locking itself out of its own tenant
with two clicks, with no recovery short of a database edit — the same class of
dead end as the undeactivatable branch, and far cheaper to prevent than to
support.

## 7. Testing

`scripts/staff-check.mjs`, matching the existing suites: no framework,
assert-and-count, **unconditional section-0 fixture reset** so consecutive
runs are idempotent. Server Actions using `next/headers` cannot be invoked
from a standalone script; they are driven through the dev server on port 3001.

Numbered assertions:

1. `staff_profiles` exists with RLS enabled; the unique constraint refuses a
   second branch for one person.
2. The insert trigger seeds a profile for a new member; the backfill covered
   members that existed before the migration.
3. The owner consumes a seat.
4. Deactivating a stylist frees a seat — proven through the real quota path,
   by successfully hiring into the freed seat, not by re-reading a count.
5. Reactivating re-consumes the seat and returns **402** at the cap.
6. `stylist` and `frontdesk` require a branch; `owner` and `admin` have
   `team_id` null.
7. Promoting a stylist to admin clears the assignment; demoting requires one.
8. The last owner cannot be deactivated, **including from two concurrent
   connections** — proven against the live database, the way the branch race
   was.
9. An owner cannot deactivate themselves.
10. Assigning to a closed branch is 409; to a locked branch is 402; a branch
    that is both yields 409.
11. Deactivation and password reset both actually revoke sessions — verified
    by trying the old cookie afterwards, not by observing that the call was
    made.
12. A stylist and a front-desk user are each redirected away from `/staff`.
13. Another salon's staff id reads as not-found and leaks no name.
14. Every `staff_profiles` row with a `team_id` has a matching `team_members`
    row.
15. Import: one bad row creates nothing.
16. Import: exceeding remaining seats returns one 402 naming the shortfall.
17. Import: a clean file creates every row.

**Every load-bearing assertion gets break-and-restore evidence** — break the
production code, watch that specific assertion fail, restore, watch it pass.
Three of the branch feature's rules went unasserted and those were precisely
the three that were broken; two others passed for the wrong reason and were
caught only by adversarial review.

The pre-existing suites must not move: `auth:check` 70, `plan:check` 38,
`ui:check` 16, `branch:check` 44.

## 8. Code organisation

`app/api/staff/route.ts` **stays**. It is covered by `auth:check` and encodes
two hard-won decisions: it builds the user with `internalAdapter.createUser`
plus `linkAccount` rather than `signUpEmail` (which mints a session that
`nextCookies` would attach, logging the owner in as their own new hire), and
it marks the account `emailVerified` because it never goes through
`sendVerificationEmail` and would otherwise be locked out forever.

That provisioning logic moves into `lib/staff.ts`, called by both the route
and the new Server Action — written once, and the passing suite undisturbed.

`lib/staff.ts` also owns the profile/`team_members` write pair (§3.3) and the
assignment queries branch deactivation consults.

## 9. Known follow-ups

- **Branch deletion.** With §2.4's branch counterpart, a salon's branch count
  only ever rises; a permanently closed location is billed forever. The fix is
  a real delete with its own guards, not making deactivation free the slot,
  which would reopen cap evasion. Sequenced after this feature because
  deleting a branch must say what happens to staff assigned to it.
- **Multi-branch cover**, per §2.1, when scheduling exists.
- **A real mail transport.** `.mail.log` means self-serve signup and password
  reset cannot reach a stranger. The adapter seam in `lib/notify.ts` is
  already in place; it needs a transport written and swapped in.
