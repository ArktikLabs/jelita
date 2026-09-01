# Tests

Three tools, each doing what it is for.

| What you are testing | Where it goes | Runner |
|---|---|---|
| Pure logic (`normalizePhone`, `parseMoney`) | `tests/*.test.ts` | Vitest |
| Database behaviour — constraints, triggers, RLS, views | `tests/*.db.test.ts` | Vitest + `pg` |
| Concurrency — two connections, forced lock orderings | `tests/*.db.test.ts` | Vitest + `pg` |
| Flows through the running app — guards, redirects, form posts, RSC payload | `tests/e2e/*.spec.ts` | Playwright |

```bash
pnpm test:db        # start the disposable Postgres (once)
pnpm test           # Vitest
pnpm test:e2e       # Playwright
pnpm test:db:down   # tear the database down
```

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

Seven assertions in this project have passed for the wrong reason — a fixture
whose subject was missing a row the query joined on, a test whose own
`FormData` normalised the input under test, a currency check where every
fixture used the default. None were caught by review; all were caught by
breaking the production code and watching.

So for anything load-bearing: break it, watch that specific assertion fail,
restore, watch it pass.

**The break has to compile.** An edit that fails the build fails the run
without exercising the assertion at all, and proves nothing.
