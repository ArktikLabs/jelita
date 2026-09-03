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

## One assertion carries no break-and-restore evidence

Both were migrated from the retired `staff-check.mjs`, and the sandbox's tool
classifier refuses edits that weaken a security or concurrency guard — so
neither the migration nor a later attempt could run the suite against a
deliberately broken version. Recorded here rather than left implied.

**The privilege-escalation allow-list** (`ASSIGNABLE_ROLES`,
`app/dashboard/(shell)/staff/actions.ts`). It stops `role=owner` from minting a second
owner — an admin holds `staff:['create']`, so without it an admin could grant
themselves org-deletion rights. The migrated assertion is written in the right
shape: it checks the **member row count**, not merely that an error came back,
because code can refuse a response after already writing the row. But nobody
has watched it fail.

**Closed:** the ownerless-salon guarantee moved into the database (migration
0025, `refuse_ownerless_salon`) and now has four breaks of its own in
`tests/owner-guard.db.test.ts` — removing the trigger, making it non-deferred,
dropping the `staff_profiles` half, and dropping the organization-existence
check each fail a distinct assertion. `deactivateStaffAction`'s
`for update of s, m` lock is now the friendly half rather than the guarantee.

**Also closed:** demote-versus-demote, which was a known accepted gap. The same
trigger refuses it. Worth reading if you ever write one: **deferring the check
was not enough.** A deferred trigger takes its snapshot while the transaction
is committing, so two commits at the same instant each still saw the other's
owner and both passed. The trigger takes `for update` on the organization row
first, which gives them something to contend on. The version without the lock
fails the race assertion on every run.


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
