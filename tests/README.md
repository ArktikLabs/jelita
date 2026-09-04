# Tests

Three tools, each doing what it is for.

| What you are testing | Where it goes | Runner |
|---|---|---|
| Pure logic (`normalizePhone`, `parseMoney`) | `tests/*.test.ts` | Vitest |
| Database behaviour — constraints, triggers, RLS, views | `tests/*.db.test.ts` | Vitest + `pg` |
| Concurrency — two connections, forced lock orderings | `tests/*.db.test.ts` | Vitest + `pg` |
| Flows through the running app — guards, redirects, form posts, RSC payload | `tests/e2e/*.spec.ts` | Playwright |

```bash
pnpm test:db        # start the disposable Postgres AND MinIO (once)
pnpm test           # Vitest
pnpm test:e2e       # Playwright
pnpm test:db:down   # tear the database down
```

## The database is disposable — and now actually is

Global setup drops and rebuilds the schema before migrating, and Playwright
never reuses a server across runs. Both were added after a pre-merge check
caught what looked like a flaky spec file:

- The container stays up between runs, so fixtures **accumulated**. Each spec's
  own cleanup then cascade-deleted through a dozen tables, and once enough runs
  had piled up a `delete from organizations` blew a 30s `beforeAll` timeout and
  skipped a whole file. Runs had crept from under a minute to sixteen.
- A server left running from a previous run holds **warm pooled connections to
  a schema that global setup just dropped**. Same symptom: no clean error, just
  a run that limps and eventually times out somewhere unrelated.

Neither presents as its own cause, which is why they are written down here.
A full run should take about a minute. If it takes materially longer,
suspect stale state before suspecting the test that failed.

## The database is disposable

`docker-compose.test.yml` runs Postgres 17 on 55432, RAM-backed. Both runners'
global setup applies **the real migration files** and **the real plan seed**, so
the test schema cannot drift from production.

The seed is not optional: creating an organization fires a trigger that
subscribes it to the default plan, and without one every salon fixture fails
with `no default plan configured`.

A fresh database per run makes a whole bug class impossible. The suites used to
share Supabase, and a run that died between lowering a plan cap and restoring
it left the cap corrupted — which the next run then read as its "original"
value and faithfully restored, laundering the corruption forward. With nothing
persisting between runs there is nothing to launder.

## Things that will bite you

**Send an `Origin` header on state-changing API calls.** better-auth's CSRF
check rejects them otherwise with `MISSING_OR_NULL_ORIGIN` (403). A browser
sends it automatically; a Playwright `request` context does not. See
`client()` in `tests/e2e/ui.spec.ts`.

**e2e builds to `.next-e2e`.** Next's dev-server lock is scoped to the output
directory, so without a separate `distDir` a running `pnpm dev` blocks the e2e
server outright.

**Sign in *after* the membership row exists.** `lib/auth.ts` resolves
`activeOrganizationId` when a session is created. Signing in first yields a
session with no active org, and every guarded page redirects regardless of
permissions — which looks exactly like a permissions bug.

**Do not call `/sign-up/email` unless it is the thing under test.**
`lib/auth.ts` rate-limits sign-up to 5/hour and sign-in to 10/min,
process-wide. That budget is shared by every e2e spec file, and the limiter is
in-memory — tearing the database down does not reset it. The existing specs
already sum to the whole allowance, so a file that signs up naively does not
fail on its own: it makes some *other* file fail with a 429 that looks like a
real bug. Use `createLogin` / `createSalon` from `tests/e2e/fixtures.ts`, which
insert the credential row directly using better-auth's own hasher.

**Poll, do not sleep.** `waitForMail` in `tests/e2e/mail.ts` polls `.mail.log`.
A fixed sleep is a guess at how long a round trip takes: too short and it fails
for no reason, too long and every run pays the worst case.

## The rule that matters

**An assertion nobody has watched fail is not yet evidence.**

Eleven assertions in this project have passed for the wrong reason — a fixture
whose subject was missing a row the query joined on, a test whose own
`FormData` normalised the input under test, a currency check where every
fixture used the default, a concurrency test whose two calls never actually
collided, a "does not block deactivation" test that re-typed the query it was
supposed to be checking, a rounding test whose numbers rounded the same way in
both directions, an ownerless-salon race that serialised by luck of timing. None were caught by review; all were caught by
breaking the production code and watching.

So for anything load-bearing: break it, watch that specific assertion fail,
restore, watch it pass.

**The break has to compile.** An edit that fails the build fails the run
without exercising the assertion at all, and proves nothing.

## Every assertion now carries break-and-restore evidence

This section used to list two that did not. Both are closed.

**The privilege-escalation allow-list** (`ASSIGNABLE_ROLES`,
`lib/permissions.ts`). It stops `role=owner` from minting a second owner — an
admin holds `staff:['create']`, so without it an admin could grant themselves
org-deletion rights. The break had never been run, because the sandbox used to
refuse edits weakening a security guard. It runs now: adding `'owner'` back to
the list fails exactly two assertions in `tests/e2e/staff.spec.ts`, both on the
**member row count** rather than a status code — the JSON route and the form.

**The ownerless-salon guarantee** moved into the database (migration 0025,
`refuse_ownerless_salon`) and has four breaks of its own in
`tests/owner-guard.db.test.ts`: removing the trigger, making it non-deferred,
dropping the `staff_profiles` half, and dropping the organization lookup each
fail a distinct assertion. `deactivateStaffAction`'s `for update of s, m` lock
is now the friendly half rather than the guarantee.

**Also closed:** demote-versus-demote, previously a known accepted gap.

## Concurrency tests are the easiest to write wrong

Four assertions in this project have "passed" against a deliberately broken
guard, because they serialised by accident rather than by the thing under test:

| Shape | Why it proves nothing |
|---|---|
| `insert().then(commit)` on both connections | the first finishes entirely before the second starts |
| `allSettled` on both inserts, commit after | deadlocks when the second blocks on the first's lock |
| act on A, issue B, commit A | A's commit can land before B's statement reaches the server |
| two `createBooking` calls at once | their queries interleave and the second reads the first's row |

And one that looked like a fix but was not: **deferring a constraint trigger
is not serialisation.** A deferred trigger takes its snapshot while the
transaction is committing, so two commits at the same instant each still see
the other's pre-change state. Both migration 0025 and 0026 take `for update`
on the organization row first, which is what actually makes them contend.

What works: **hold the contended state open deliberately** — an uncommitted
row, or a lock — poll `pg_stat_activity` until the other side is provably
waiting, then release. And assert the OUTCOME that differs (a seat count, a
stylist id), never which promise rejected.

Run a concurrency break three times before believing it.

## One guard is redundant, and its test asserts the coupling instead

`bookableBranches` (`lib/salon.ts`) filters on `active && withinCap`. The
`active` half is redundant: `branch_entitlement` ranks only active branches
(`db/migrations/0008_branch_tables.sql`), so a closed branch has no row and
`listBranches` coalesces its `within_cap` to `false`. Deleting `b.active` fails
nothing, and no test can make it fail — **"closed but within cap" is
unrepresentable**, so an assertion aimed at it could only ever pass.

This is not the same as the two above. There is nothing missing here; the
guard simply cannot be exercised while the view holds.

So the *view's* guarantee is asserted directly instead, in
`tests/salon.db.test.ts` — a closed branch has no `branch_entitlement` row at
all. That one **does** fail (verified: removing `where p.active` from the view
fails it and nothing else), and it is the assertion that would fire if the
coupling ever changed — at which point `b.active` stops being redundant and
starts being the thing keeping strangers out of a closed branch.

The general shape, worth reusing: when a guard is unfalsifiable because
something upstream subsumes it, assert the upstream guarantee rather than
deleting the guard or claiming coverage for it.

---

## Notifications (PRD §5.5)

Eleven breaks across the slice, each watched failing its own assertion:
blanking an unknown placeholder, rendering at read time, queuing three events,
cancelling sent messages, ignoring `send_at`, dropping the salon scope, queuing
for a customer with no number, dropping the one-per-event guard, never queuing
on booking, cancelling on completion, and forgetting `no_show`.

Two things worth carrying forward.

**`every` on an empty array is true.** `expect(rows.every(r => r.status ===
'cancelled')).toBe(true)` passed just as well when nothing had been queued at
all — so a break that deleted the queue call was caught by two tests instead of
four. The length is asserted first now. Any `every`/`some` assertion over rows
a fixture produced has this shape; assert the count in the same test.

**Three breaks that all fail the same test are a warning, not a result.** A
`brk` helper re-captured its "original" copy from a file that already had the
first break applied, so every restore silently re-applied it and all three
breaks reported identical failures. Identical failure sets from breaks aimed at
different code is the signal. Break-and-restore should restore from **git**,
and the patch should assert it actually changed the file.

**Screenshotting is not optional for a page.** `KIND_LABEL` was exported from a
`'use client'` module, so the server component got a client reference rather
than the object and the event column rendered blank for every row. tsc, the
build and 390 unit tests all passed. Only looking at the page found it.

### Break-and-restore: commit first, always

The trap in the notifications section bit twice more during the email slice,
in two new disguises:

- `git checkout HEAD -- <file>` restored a file whose feature was **not yet
  committed**, so "restore" silently deleted the code under test and the next
  run failed identically to the break. The break looked confirmed twice over.
- The same command cannot restore an **untracked** file at all. Breaking a
  brand-new route left it broken with no error.

The rule that removes both: **commit the work, then break it.** The restore is
then `git checkout HEAD -- <file>` plus `git status --short <file>` printing
nothing. If the restore leaves the file dirty, or a re-run still fails, the
baseline was wrong -- not the code.
