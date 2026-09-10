# Audit Columns (Phase 3) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record who created, last changed, and deactivated every record — and make forgetting to record it a compile error rather than a silently null column.

**Architecture:** Timestamps are the database's job (defaults and a trigger); actors are the caller's, threaded as **required parameters** on the lib functions. `lib/` stays session-free, so the query layer keeps running against a bare pool in Vitest.

**Tech Stack:** Postgres 17, Drizzle, Next.js 16 App Router (RSC), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-08-crud-standard-design.md` §5
**Phases 1-2:** merged as `ab5afe8` and `9d6aa9e`

## Global Constraints

- **`active` remains the single truth for "is this live".** `deleted_at` and `deleted_by` record *when* and *by whom* it stopped being offered. §5.1 exists because the name invites the wrong query.
- **Timestamps are the database's job; actors are the caller's.** `created_at` defaults to `now()`, `updated_at` gets a trigger. The `*_by` columns are required parameters, following `recordMovement({ actorUserId })`.
- **`lib/` stays session-free.** Only `lib/session.ts` resolves a user. No `SET LOCAL app.actor_id` scheme — it would be unforgettable *and* would stamp NULL through every test run.
- **A NULL actor is information, not absence.** A public booking, the seed and the cron have no signed-in user. NULL reads as "not created by a signed-in person".
- **Transactions get `created_by` and nothing else.** Settled rows are immutable by trigger, so `updated_by` could never be written, and a column that can never be written is a lie in the schema.
- No new dependency. Indonesian UI copy.

## What already exists — the migration is smaller than §5 implies

Verified against the live schema at plan time:

| table | has | needs |
|---|---|---|
| customers, products, services | `active`, `created_at`, `updated_at` | `created_by`, `updated_by`, `deleted_at`, `deleted_by` |
| staff_profiles, branch_profiles | `active`, `created_at`, `updated_at`, **`deactivated_at`** | `created_by`, `updated_by`, `deleted_by` + **rename** `deactivated_at` → `deleted_at` |
| transactions | `created_at`, `updated_at` | `created_by` only |

**Nothing maintains `updated_at` today.** There are 31 hand-written `updated_at = now()` sites and zero triggers — so the trigger in Task 1 is not redundancy, it is the first thing that makes the column trustworthy.

---

### Task 1: The migration

**Files:**
- Create: `db/migrations/00NN_audit_columns.sql` (last is `0034_list_indexes.sql`)
- Modify: `lib/schema/{customer,inventory,service,staff,branch,pos}.ts`
- Modify: the 11 existing `deactivated_at` sites (2 schema files, 4 action sites, 3 tests, and any the grep below finds)
- Test: `tests/audit.db.test.ts` (new)

**Interfaces:**
- Produces: the columns above, an `updated_at` trigger on all six tables, and `deleted_at`/`deleted_by` replacing `deactivated_at`.

- [ ] **Step 1: Find every `deactivated_at` site before renaming anything**

```bash
grep -rn 'deactivated_at\|deactivatedAt' lib app db tests scripts --include='*.ts' --include='*.tsx' --include='*.sql'
```

At plan time this was 11 sites. Record what you actually find — a rename that misses one fails at runtime, not at compile time, because the SQL is in template strings.

- [ ] **Step 2: Write the failing test**

Create `tests/audit.db.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from './db'

/**
 * The audit columns, asserted against real Postgres. These are schema
 * guarantees, so only the database can confirm them.
 */
const pool = new Pool({ connectionString: TEST_DATABASE_URL })
const ORG = 'audit_org'

const columns = async (table: string) => (await pool.query(
  `select column_name from information_schema.columns
    where table_schema='public' and table_name=$1`, [table])).rows.map((r) => r.column_name)

beforeAll(async () => {
  await pool.query(`delete from organizations where id = $1`, [ORG])
  await pool.query(
    `insert into organizations (id, name, slug, created_at) values ($1, 'Audit', 'audit-org', now())`,
    [ORG])
})
afterAll(async () => {
  await pool.query(`delete from organizations where id = $1`, [ORG])
  await pool.end()
})

describe('the audit columns exist where they should', () => {
  for (const t of ['customers', 'products', 'services']) {
    it(`${t} carries all four`, async () => {
      const cols = await columns(t)
      for (const c of ['created_by', 'updated_by', 'deleted_at', 'deleted_by']) {
        expect(cols, `${t}.${c}`).toContain(c)
      }
    })
  }

  for (const t of ['staff_profiles', 'branch_profiles']) {
    it(`${t} was renamed, not doubled`, async () => {
      const cols = await columns(t)
      expect(cols).toContain('deleted_at')
      expect(cols).toContain('deleted_by')
      // The rename must REPLACE the old name. Two columns for one concept is
      // the drift this phase exists to end.
      expect(cols, 'deactivated_at must be gone').not.toContain('deactivated_at')
    })
  }

  it('transactions carries created_by and NOT updated_by', async () => {
    const cols = await columns('transactions')
    expect(cols).toContain('created_by')
    // Settled rows are immutable by trigger, so updated_by could never be
    // written. A column that can never be written is a lie in the schema.
    expect(cols).not.toContain('updated_by')
  })
})

describe('updated_at maintains itself', () => {
  it('moves on update without the caller setting it', async () => {
    // 31 sites set `updated_at = now()` by hand today and nothing enforced it.
    // The trigger is what makes the column trustworthy.
    await pool.query(
      `insert into customers (id, organization_id, name) values ('audit_c1', $1, 'Awal')`, [ORG])
    const { rows: [before] } = await pool.query(
      `select updated_at from customers where id = 'audit_c1'`)
    await pool.query(`select pg_sleep(0.01)`)
    await pool.query(`update customers set name = 'Diubah' where id = 'audit_c1'`)
    const { rows: [after] } = await pool.query(
      `select updated_at from customers where id = 'audit_c1'`)
    expect(new Date(after.updated_at).getTime())
      .toBeGreaterThan(new Date(before.updated_at).getTime())
  })
})

describe('the actor columns reference a real user', () => {
  it('refuses an actor who does not exist', async () => {
    await expect(pool.query(
      `insert into customers (id, organization_id, name, created_by)
       values ('audit_c2', $1, 'Palsu', 'no-such-user')`, [ORG]))
      .rejects.toThrow(/foreign key|violates/i)
  })

  it('allows a NULL actor, which means "not a signed-in person"', async () => {
    // A public booking, the seed and the cron all write without a session.
    await expect(pool.query(
      `insert into customers (id, organization_id, name, created_by)
       values ('audit_c3', $1, 'Publik', null)`, [ORG])).resolves.toBeDefined()
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm vitest run tests/audit.db.test.ts`
Expected: FAIL — the columns do not exist and `updated_at` does not move.

- [ ] **Step 4: Write the migration**

Generate with `pnpm db:generate --custom --name audit_columns`, then replace the body:

```sql
-- Actors, on the tables a person edits. NULLABLE and NOT defaulted: a public
-- booking, the seed script and the cron all write without a signed-in user,
-- and NULL there means "not created by a person" rather than "we forgot".
alter table customers  add column created_by text references users (id) on delete set null;
alter table customers  add column updated_by text references users (id) on delete set null;
alter table products   add column created_by text references users (id) on delete set null;
alter table products   add column updated_by text references users (id) on delete set null;
alter table services   add column created_by text references users (id) on delete set null;
alter table services   add column updated_by text references users (id) on delete set null;
alter table staff_profiles  add column created_by text references users (id) on delete set null;
alter table staff_profiles  add column updated_by text references users (id) on delete set null;
alter table branch_profiles add column created_by text references users (id) on delete set null;
alter table branch_profiles add column updated_by text references users (id) on delete set null;
--> statement-breakpoint
-- Transactions get created_by and NOTHING else. A settled row is immutable by
-- trigger, so updated_by could never be written -- and who voided a sale is
-- already recorded: the reversal is its own row with its own created_by.
alter table transactions add column created_by text references users (id) on delete set null;
--> statement-breakpoint
-- `deleted_at` records WHEN a record stopped being offered, and `deleted_by`
-- by whom. It does NOT mean "hide this row": `active` remains the single
-- truth for that, and a deactivated stylist must still appear in the payroll
-- for a month they worked (spec §5.1).
alter table customers add column deleted_at timestamp with time zone;
alter table customers add column deleted_by text references users (id) on delete set null;
alter table products  add column deleted_at timestamp with time zone;
alter table products  add column deleted_by text references users (id) on delete set null;
alter table services  add column deleted_at timestamp with time zone;
alter table services  add column deleted_by text references users (id) on delete set null;
--> statement-breakpoint
-- These two already carry the concept under the old name. RENAME rather than
-- add, so one concept keeps one name across the schema.
alter table staff_profiles  rename column deactivated_at to deleted_at;
alter table branch_profiles rename column deactivated_at to deleted_at;
alter table staff_profiles  add column deleted_by text references users (id) on delete set null;
alter table branch_profiles add column deleted_by text references users (id) on delete set null;
--> statement-breakpoint
-- Nothing maintained updated_at before this: 31 call sites set it by hand and
-- any new one could forget. A trigger is the only version of this column that
-- can be trusted, which is what makes it worth reading.
create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;
--> statement-breakpoint
create trigger customers_touch_updated_at       before update on customers       for each row execute function touch_updated_at();
create trigger products_touch_updated_at        before update on products        for each row execute function touch_updated_at();
create trigger services_touch_updated_at        before update on services        for each row execute function touch_updated_at();
create trigger staff_profiles_touch_updated_at  before update on staff_profiles  for each row execute function touch_updated_at();
create trigger branch_profiles_touch_updated_at before update on branch_profiles for each row execute function touch_updated_at();
```

⚠️ **No `updated_at` trigger on `transactions`.** Its settled rows are guarded by `transactions_settled_immutable`, which raises on any update — a `before update` trigger there would either never fire or fight the guard. Leave it.

- [ ] **Step 5: Update the Drizzle schema and rename the 11 sites**

Add the columns to the six `lib/schema/*.ts` files, and rename every `deactivated_at` / `deactivatedAt` found in Step 1. The four action sites read `set active = false, deactivated_at = now()` — they become `deleted_at = now(), deleted_by = <actor>` in Task 2, so for now change only the column name and leave the actor for that task.

- [ ] **Step 6: Verify and commit**

Run: `pnpm vitest run && pnpm exec tsc --noEmit && pnpm build`
Then the suites that touch the renamed columns: `E2E_PORT=3105 pnpm exec playwright test tests/e2e/staff.spec.ts tests/e2e/branch.spec.ts --reporter=line`

```bash
git add db/migrations lib/schema tests/audit.db.test.ts app lib
git commit -m "feat(audit): who created, changed and deactivated each record

Actors are nullable and undefaulted: a public booking, the seed and the cron
all write without a signed-in user, and NULL means 'not a person' rather than
'we forgot'.

deactivated_at is RENAMED to deleted_at on the two tables that had it, so one
concept keeps one name. It records when a record stopped being offered, not
whether to hide it -- active remains the truth for that, and a deactivated
stylist must still appear in the payroll for a month they worked.

updated_at gets a trigger. Thirty-one sites set it by hand and nothing
enforced it, so the column was never trustworthy enough to read.

Transactions get created_by only: a settled row is immutable, so updated_by
could never be written, and a column that can never be written is a lie."
```

---

### Task 2: Thread the actor through the write paths

**Files:**
- Modify: `lib/customer.ts`, `lib/inventory.ts`, `lib/service.ts`, `lib/staff.ts`, `lib/branch.ts`, `lib/pos.ts`
- Modify: their Server Actions under `app/dashboard/(shell)/*/actions.ts`
- Test: `tests/audit.db.test.ts`

**Interfaces:**
- Consumes: the columns from Task 1.
- Produces: an `actorUserId` (or `actor`) required parameter on every create/update/deactivate function that writes to the six tables.

At plan time there were 21 write sites across the six tables. `recordMovement({ actorUserId })` in `lib/inventory.ts` is the existing precedent — follow its shape exactly.

- [ ] **Step 1: Write the failing tests**

For each of create, update and deactivate on at least customers and services:

```ts
it('records who created it', async () => {
  const c = await createCustomer({ organizationId: ORG, name: 'Baru', actorUserId: ACTOR })
  const { rows: [row] } = await pool.query(
    `select created_by, updated_by from customers where id = $1`, [c.id])
  expect(row.created_by).toBe(ACTOR)
  // created_by is set on insert and never touched again; updated_by is null
  // until someone actually changes the row, so the two are distinguishable.
  expect(row.updated_by).toBeNull()
})

it('records who changed it, without disturbing who created it', async () => {
  await updateCustomer(c.id, ORG, { name: 'Diubah' }, OTHER_ACTOR)
  const { rows: [row] } = await pool.query(
    `select created_by, updated_by from customers where id = $1`, [c.id])
  expect(row.created_by).toBe(ACTOR)
  expect(row.updated_by).toBe(OTHER_ACTOR)
})

it('records who deactivated it, and leaves active as the truth', async () => {
  await deactivateCustomer(c.id, ORG, ACTOR)
  const { rows: [row] } = await pool.query(
    `select active, deleted_at, deleted_by from customers where id = $1`, [c.id])
  expect(row.active).toBe(false)
  expect(row.deleted_at).not.toBeNull()
  expect(row.deleted_by).toBe(ACTOR)
})

it('clears the deactivation stamp on reactivation', async () => {
  // Reactivation is a first-class feature here (branches, services, staff all
  // have it). A row that is live again must not still claim a deletion date.
  await reactivateCustomer(c.id, ORG, ACTOR)
  const { rows: [row] } = await pool.query(
    `select active, deleted_at, deleted_by from customers where id = $1`, [c.id])
  expect(row.active).toBe(true)
  expect(row.deleted_at).toBeNull()
  expect(row.deleted_by).toBeNull()
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run tests/audit.db.test.ts`

- [ ] **Step 3: Thread the actor**

**Required, not optional.** `actorUserId: string` on a signed-in write path, so omitting it is a compile error rather than a silently null column. The Server Action supplies it from the session — that is the only layer that knows it, and keeping the resolution there is what keeps `lib/` callable from Vitest against a bare pool.

Paths with genuinely no actor — the public booking page's customer creation, the seed, the cron — pass `null` **explicitly**, so the absence is a decision at the call site rather than a default nobody chose.

- [ ] **Step 4: Verify and commit**

Run: `pnpm vitest run && pnpm exec tsc --noEmit && pnpm build`, plus the e2e suites for every page whose actions changed.

- [ ] **Step 5: Break-and-restore**

Commit FIRST, then: make `actorUserId` optional on one function and watch the "records who created it" test fail; write `deleted_at` without clearing it on reactivate and watch that test fail; set `updated_by` on insert and watch the "distinguishable" assertion fail. Restore each with `git checkout HEAD -- <file>` and confirm `git status --short` is clean.

---

### Task 3: The two staff bugs the phase-2 review surfaced

**Files:**
- Modify: `app/dashboard/(shell)/staff/actions.ts` (`memberIdFor`), `lib/payroll.ts`
- Test: `tests/staff.db.test.ts`, `tests/payroll.db.test.ts`

Both are pre-existing, both are adjacent to the dual-membership scenario phase 2's security fix made reachable, and both are in the tables this phase is already touching.

- [ ] **Step 1: `memberIdFor` picks a row at random**

`app/dashboard/(shell)/staff/actions.ts:119-124` is `select id from members where user_id = … and organization_id = … limit 1` with **no `order by`**. For a person with two membership rows, a role update or demote touches a nondeterministic one — so demoting an owner can silently edit their *other* row and leave them an owner.

Write the test first: a person with two membership rows, demote them, and assert the OWNER row is the one that changed. Then fix — either an explicit `order by` making the choice deterministic, or (better) act on all of that person's rows in the org, since the guards already treat their roles as a comma-joined set.

- [ ] **Step 2: `lib/payroll.ts` joins `members` without dedup**

`lib/payroll.ts:70` and `:93` both `join members m on m.user_id = … and m.organization_id = …`. `members` carries no unique on that pair, so a dual-membership person can produce **duplicate payroll rows** — and payroll is money.

Write the test first: give a person two membership rows and assert the payroll recap lists them once with one salary. Then fix, following `listStaff`'s established `group by` shape.

⚠️ This is the more serious of the two. Duplicated payroll is a wrong payment, not a display glitch.

- [ ] **Step 3: Verify, commit, break-and-restore**

Break each fix and watch its own test fail.

---

### Task 4: Surface it

**Files:**
- Modify: the detail pages under `app/dashboard/(shell)/*/[id]/page.tsx`
- Test: one e2e assertion per surfaced page

Columns nobody can see are plumbing, not a feature. §5's whole point is answering "who changed this", and today that answer would sit in the database unread.

A single quiet line on each detail page:

> `Dibuat oleh Ibu Ovarya · 12-05-2027 · Diubah oleh Dewi Anggraini · 09-09-2027`

⚠️ **Only where a detail page exists.** Do not invent new pages for this.
Checked at plan time: customers, services, staff, branches and transactions
have `[id]` pages; **products does not** — it is edited inline from the list.
So products gets its audit columns and no surface, and that is the correct
outcome rather than a gap: building a detail page to display two timestamps
would be the tail wagging the dog. Say so in your report rather than
improvising one.

Transactions is the odd one: its detail page is a receipt, and `created_by` is
the cashier, which the receipt already names. Add the line only if it says
something the receipt does not.

⚠️ **A NULL actor renders as something honest** — "Dibuat saat impor" or "Dibuat dari halaman booking" where the context is known, and simply omitted where it is not. Never "Dibuat oleh —", which reads as a missing name rather than an absent person.

Deactivated records show their deactivation line too, since that is the one people ask about.

---

## Self-Review

**Spec coverage.** §5 columns → Task 1. §5.1 (`deleted_at` does not mean hide) → enforced by leaving every list reading `active`, and stated in the migration. §5.2 (timestamps database, actors caller) → Tasks 1 and 2.

**Beyond the spec, deliberately:** Task 3's two bugs (the phase-2 review found them; they live in these tables) and Task 4 (the spec does not mention UI, and columns nobody reads are not an audit trail).

**Deferred, tracked:** phase 4's bulk actions and CSV export; and phase 2's deferred list — `escapeLike` duplication, `ListQuery.perPage` carrying no trace of its allow-list (phase 4 will lean on that seam), the duplicated search form, `transactions_day_idx`'s missing trailing `id`, and the two role-display consumers that render `admin,owner` raw.

**Risk worth stating:** Task 1 renames a column in template-string SQL, where a miss fails at runtime rather than at compile time. Step 1's grep is the whole defence, which is why it comes before anything else.
