# The Remaining Five Resources (Phase 2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put products, services, branches, staff and transactions on the list contract phase 1 proved, and close the four gaps phase 1 deferred.

**Architecture:** Each resource declares a `ListSpec` and keeps its own hand-written SQL body, slotting in the shared `orderBy`/`paginate` fragments. Two contract extensions land first, because five resources need them and retrofitting after five call sites exist is five times the work.

**Tech Stack:** Next.js 16 App Router (RSC), Drizzle `sql` templates, Postgres 17, Vitest (unit + real DB), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-08-crud-standard-design.md`
**Phase 1:** `docs/superpowers/plans/2026-09-08-crud-standard-phase-1.md` (merged as `ab5afe8`)

## Global Constraints

Everything from phase 1 still binds:

- `per` is an allow-list: **25, 50, 100, default 25**.
- `sort` is **looked up** in the spec, never interpolated. Unknown → default sort.
- Every emitted `ORDER BY` ends with a **tiebreaker column**.
- A column may only be declared `sortable` if **an index supports it**.
- Page numbers with an **exact total**; a page past the end **clamps**.
- Count and page query run **in parallel**.
- **No new dependency.**
- `lib/` stays session-free.
- Indonesian UI copy.
- Every list control routes through `listHref` / `preservedFields` — no control composes its own query string or hand-enumerates what it preserves.

Plus one new rule this phase establishes:

- **A resource whose query can return more than one row per entity MUST count `distinct <tiebreak>`.** See Task 2's investigation — this is true for exactly one of the five, and the rule exists so the next person does not have to re-derive which.

## What phase 1 deferred, and where it lands here

| deferred item | task |
|---|---|
| generic `ListSpec<K>` so a typo'd column is a compile error | Task 1 |
| `NULLS LAST` support in `orderBy` | Task 1 |
| the tiebreak direction / index direction mismatch | Task 1 |
| `per` dropped by the search form | already fixed by `preservedFields` in phase 1's final wave — verify only |
| the untested desc-fallback branch of `parseListQuery` | Task 1 |
| `<FilterBar>` — the `active` filter is preservable but not operable | Task 6 |

---

### Task 1: Extend the contract before five resources depend on it

**Files:**
- Modify: `lib/list-query.ts`
- Modify: `lib/customer.ts` (the one existing spec, to the new shape)
- Modify: `components/list/sortable-head.tsx` (generic over the spec's keys)
- Test: `tests/list-query.test.ts`

**Interfaces:**
- Consumes: the phase-1 contract as merged.
- Produces: `ListSpec<K extends string>` with `sortable: Record<K, string | { asc: string; desc: string }>`; `orderBy` honouring the per-direction form and directional tiebreak.

Four changes, one commit, because they all touch `orderBy`'s emitted SQL and splitting them would mean three rounds of "re-verify the emitted string".

- [ ] **Step 1: Write the failing tests**

Add to `tests/list-query.test.ts`:

```ts
const NULLABLE: ListSpec<'price' | 'name'> = {
  sortable: {
    // A column that is NULLABLE needs its own ordering per direction: nulls
    // belong at the END whichever way the user sorted, and `nulls last`
    // cannot be appended after a direction keyword.
    price: { asc: 'p.price asc nulls last', desc: 'p.price desc nulls last' },
    name: 'p.name',
  },
  defaultSort: 'name',
  tiebreak: 'p.id',
}

describe('orderBy with per-direction expressions', () => {
  it('uses the direction-specific expression verbatim', () => {
    expect(render(orderBy(NULLABLE, parseListQuery(NULLABLE, { sort: '-price' }))))
      .toBe('order by p.price desc nulls last, p.id desc')
    expect(render(orderBy(NULLABLE, parseListQuery(NULLABLE, { sort: 'price' }))))
      .toBe('order by p.price asc nulls last, p.id asc')
  })

  it('still appends a direction to a plain string expression', () => {
    expect(render(orderBy(NULLABLE, parseListQuery(NULLABLE, { sort: '-name' }))))
      .toBe('order by p.name desc, p.id desc')
  })
})

describe('the tiebreak follows the sort direction', () => {
  it('so one btree index serves both directions', () => {
    // `created_at desc, id asc` cannot be served by a plain (created_at, id)
    // index in either scan direction, so Postgres adds a sort node. Matching
    // the tiebreak to the sort makes the index an exact match both ways --
    // cheap today because created_at is near-unique, and the difference
    // between an index scan and a sort the moment a LOW-CARDINALITY column
    // like status or role is declared sortable.
    expect(render(orderBy(NULLABLE, parseListQuery(NULLABLE, { sort: '-name' }))))
      .toMatch(/, p\.id desc$/)
    expect(render(orderBy(NULLABLE, parseListQuery(NULLABLE, { sort: 'name' }))))
      .toMatch(/, p\.id asc$/)
  })
})

describe('the default sort may itself be descending', () => {
  it('keeps that direction when an unknown column falls back', () => {
    // The branch phase 1 never exercised: defaultSort carrying a '-'.
    const spec: ListSpec<'created' | 'name'> = {
      sortable: { created: 't.created_at', name: 't.name' },
      defaultSort: '-created',
      tiebreak: 't.id',
    }
    const q = parseListQuery(spec, { sort: 'salary' })
    expect(q.sort).toBe('created')
    expect(q.desc).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run tests/list-query.test.ts`
Expected: FAIL — `ListSpec` takes no type parameter; the per-direction object is not handled; the tiebreak is unconditionally ascending.

- [ ] **Step 3: Implement**

In `lib/list-query.ts`:

```ts
/** A column's ordering. A plain string takes the query's direction appended;
 *  the object form is used when the two directions differ in more than the
 *  keyword -- a nullable column wanting `nulls last` both ways is the case
 *  that forced this. */
type SortExpr = string | { asc: string; desc: string }

export type ListSpec<K extends string = string> = {
  sortable: Record<K, SortExpr>
  /** A key of `sortable`, optionally prefixed `-`. Generic, so a default
   *  naming a column that is not sortable is a compile error rather than a
   *  `sql.raw(undefined)` at runtime. */
  defaultSort: K | `-${K}`
  tiebreak: string
  searchable?: boolean
  filters?: Record<string, readonly string[]>
}

export function orderBy<K extends string>(spec: ListSpec<K>, query: ListQuery): SQL {
  const expr = spec.sortable[query.sort as K]
  const dir = query.desc ? 'desc' : 'asc'
  const column = typeof expr === 'string'
    ? `${expr} ${dir}`
    : (query.desc ? expr.desc : expr.asc)
  // The tiebreak takes the SORT's direction, not a fixed ascending: it is what
  // lets one plain btree serve both directions as an exact match.
  return sql`order by ${sql.raw(column)}, ${sql.raw(spec.tiebreak)} ${sql.raw(dir)}`
}
```

`parseListQuery` becomes `<K extends string>(spec: ListSpec<K>, params: Params)`. `SortableHead` becomes generic so `column` must be a key of the spec it is given:

```tsx
export function SortableHead<K extends string>({
  column, label, spec, query, params,
}: { column: K; label: string; spec: ListSpec<K>; query: ListQuery; params: Params })
```

⚠️ `spec` was an unused prop in phase 1 and the review flagged it as dead weight. Do NOT delete it — this is what gives it a job: it is the type anchor that makes `column="createdAt"` (for a spec whose key is `created`) fail to compile.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run tests/list-query.test.ts && pnpm exec tsc --noEmit`

- [ ] **Step 5: Fix the index that no longer matches**

The tiebreak now follows the sort, so `customers_org_created_idx (organization_id, created_at desc, id)` is the wrong shape — a mixed-direction index serves the mixed-direction order it was built for, and we no longer emit one.

Generate with `pnpm db:generate --custom --name customers_created_index_direction`, then:

```sql
-- The tiebreak now takes the sort's direction, so the emitted order is
-- `created_at desc, id desc` or `created_at asc, id asc` -- never mixed. A
-- plain (organization_id, created_at, id) btree is an exact match for both:
-- forward for ascending, backward for descending. The old mixed-direction
-- index served only one of them.
drop index if exists customers_org_created_idx;
create index customers_org_created_idx on customers (organization_id, created_at, id);
```

- [ ] **Step 6: Full suite and commit**

Run: `pnpm vitest run && pnpm exec tsc --noEmit && pnpm build`

```bash
git add lib/list-query.ts lib/customer.ts components/list/sortable-head.tsx \
  tests/list-query.test.ts db/migrations
git commit -m "feat(list): per-direction sort expressions, a typed spec, and a directional tiebreak

Three changes to orderBy's emitted SQL, together because splitting them would
mean three rounds of re-verifying the same string.

ListSpec is generic over its sortable keys, so a header naming a column the
spec does not have is a compile error rather than a click that silently sorts
nothing. That also gives SortableHead's `spec` prop the job it was missing.

A column may now carry a different expression per direction, because a
nullable column wants `nulls last` both ways and that cannot be appended after
a direction keyword. products.price needs this in Task 2.

The tiebreak takes the sort's direction rather than a fixed ascending, so one
plain btree serves both directions as an exact match. The customers index is
rebuilt plain to match; it was mixed-direction for the old emitted order."
```

---

### Task 2: Products, services and branches

**Files:**
- Modify: `lib/inventory.ts` (`listProducts`), `lib/service.ts` (`listServices`), `lib/branch.ts` (`listBranches`)
- Modify: their three pages under `app/dashboard/(shell)/`
- Create: `db/migrations/00NN_list_indexes.sql`
- Test: `tests/inventory.db.test.ts`, `tests/service.db.test.ts`, `tests/branch.db.test.ts`

**Interfaces:**
- Consumes: `ListSpec<K>`, `parseListQuery`, `orderBy`, `paginate`, `clampPage`, `toResult` from Task 1.
- Produces: `PRODUCT_LIST`, `SERVICE_LIST`, `BRANCH_LIST` and the three `list*` functions returning `ListResult<…>`.

Batched because they are the same change three times against 1:1 joins. Staff and transactions are separate tasks — each has a complication these do not.

- [ ] **Step 1: Confirm the join arity before writing a single count**

This was investigated when the plan was written; re-confirm it rather than trusting the plan, because the whole count strategy rests on it:

```bash
# products -> stock_on_hand is filtered by team_id: one row per (product, team)
grep -n 'h.team_id' lib/inventory.ts
# services -> service_categories is a single FK
grep -n 'category_id' lib/schema/service.ts
# branches: staffCount is a SUBQUERY, not a join
grep -n 'select count' lib/branch.ts
```

All three are **1:1**, so `count(*)` is correct for them and `count(distinct …)` would be pointless work. Record what you confirmed in your report.

- [ ] **Step 2: Write the failing tests**

For each of the three, mirroring `tests/customers.db.test.ts`'s paging block: a page and a true total; the tiebreaker test paging through 60 duplicate-named rows and asserting 60 distinct ids; the clamp; a filtered total; and tenant scoping. For products additionally:

```ts
it('sorts by price with the price-less products last, both directions', async () => {
  // products.price is nullable. Without `nulls last` on both directions the
  // null-priced rows sit at opposite ends depending on the sort, which reads
  // as data corruption to the person looking at it.
  await pool.query(`update products set price = null where id = $1`, [NO_PRICE])
  const asc = await listProducts(ORG, TEAM, q({ sort: 'price' }))
  const desc = await listProducts(ORG, TEAM, q({ sort: '-price' }))
  expect(asc.rows.at(-1)!.id).toBe(NO_PRICE)
  expect(desc.rows.at(-1)!.id).toBe(NO_PRICE)
})
```

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm vitest run tests/inventory.db.test.ts tests/service.db.test.ts tests/branch.db.test.ts`

- [ ] **Step 4: Add the indexes the specs promise**

Only what you declare sortable. From the audit at plan time:

| resource | already indexed | declare sortable | index needed |
|---|---|---|---|
| products | `(org, name)`, `(org, sku)` | name, sku, price | `(organization_id, price, id)` |
| services | `(org, lower(name))` | name, price | sort name as `lower(s.name)` to use it; `(organization_id, price, id)` |
| branches | `(organization_id)` only | name | `(organization_id, name, id)` on `teams` |

⚠️ **Do NOT declare `products.stock` sortable.** It is computed by the `stock_on_hand` view, not a column, so no index can back it and §3.2's promise would become a lie. If sorting by stock is wanted, it needs its own design — say so in your report rather than improvising one.

⚠️ Services sorts by `lower(s.name)` to match the existing functional index. A plain `s.name` sort will not use it.

- [ ] **Step 5: Implement the three**

Each follows `listCustomers` exactly: build the `where` fragment once, use it for BOTH the page query and the count so the two cannot drift, `Promise.all` them, clamp, `toResult`.

Update the three pages to `parseListQuery` + `<SortableHead>` + `<Pagination>` + `preservedFields`, exactly as customers does. Each gets the two distinct empty states.

- [ ] **Step 6: Verify, then commit**

Run: `pnpm vitest run && pnpm exec tsc --noEmit && pnpm build`, plus the e2e specs that touch these pages: `E2E_PORT=3105 pnpm exec playwright test tests/e2e/service.spec.ts tests/e2e/branch.spec.ts --reporter=line`

- [ ] **Step 7: Break-and-restore**

Commit FIRST. Then, one at a time: drop `nulls last` from the products price spec (must fail the price test), point a count at a different `where` than its page query (must fail a filtered-total test), remove a tiebreak (must fail a paging test). Restore each with `git checkout HEAD -- <file>` and confirm `git status --short` is clean.

---

### Task 3: Staff — the one resource whose count can over-report

**Files:**
- Modify: `lib/staff.ts` (`listStaff`), `app/dashboard/(shell)/staff/page.tsx`
- Test: `tests/staff.db.test.ts`

- [ ] **Step 1: Confirm the fan-out is real**

`listStaff` joins `members → users`, and `members` has **no unique constraint on `(user_id, organization_id)`** — migration `0010_services.sql` says that is deliberate. So one person with two member rows produces two list rows and a `count(*)` of 2.

```bash
grep -rn 'members' db/migrations/*.sql | grep -i unique   # expect: nothing on (user_id, organization_id)
sed -n '70,80p' db/migrations/0010_services.sql            # the comment explaining why
```

Record what you found. If a unique constraint HAS since been added, say so — the count strategy below becomes unnecessary and `count(*)` is correct.

- [ ] **Step 2: Write the failing test**

```ts
it('counts a person once even with two membership rows', async () => {
  // members carries no unique on (user_id, organization_id) -- deliberately,
  // per migration 0010. A plain count(*) over the members join therefore
  // reports one person twice, and the list header says "1-25 dari 26" above
  // 25 rows. This is the only one of the six resources where that is possible.
  await pool.query(
    `insert into members (id, user_id, organization_id, role, created_at)
     values ($1, $2, $3, 'stylist', now())`, [SECOND_ROW, STAFF_A, ORG])
  const r = await listStaff(ORG, q())
  expect(r.total, 'the person is counted once').toBe(baseline)
})
```

- [ ] **Step 3: Implement with `count(distinct)`**

```ts
// count(DISTINCT), not count(*): the members join can produce more than one
// row per person, because members carries no unique on
// (user_id, organization_id) by design. Every other list in this codebase
// joins 1:1 and uses count(*) -- this is the exception, and the test above is
// what keeps it from silently regressing.
db.execute(sql`select count(distinct m.user_id)::int as n from members m ${joins} ${where}`)
```

The page query needs the same treatment — a `distinct on (m.user_id)` or a `group by`, whichever reads better against the existing select list. Whichever you choose, the tiebreaker still has to make the order total.

⚠️ Staff sorts by `users.name`, and `users` is **not tenant-partitioned**, so there is no `(organization_id, name)` index to build and never will be — the sort is a join-then-sort by construction. Do not add a misleading index. State this in your report; the spec's §3.2 table needs a correction and Task 6 makes it.

- [ ] **Step 4-6: Verify, commit, break-and-restore**

The load-bearing break: change `count(distinct m.user_id)` back to `count(*)` and watch the double-membership test fail.

---

### Task 4: Transactions — and the filter shape the contract cannot express

**Files:**
- Modify: `lib/list-query.ts` (filter validators), `lib/pos.ts` (`listSales`), `app/dashboard/(shell)/transactions/page.tsx`
- Test: `tests/list-query.test.ts`, `tests/pos.db.test.ts`

- [ ] **Step 1: Extend `filters` to carry a validator**

Today `filters: Record<string, readonly string[]>` expresses a single-select enum and nothing else. Transactions filters by DATE, validated by a regex on the page. Without this the page reads `searchParams` itself alongside `parseListQuery`, which contradicts the contract's central claim that it is the only place a list reads them — and re-fragments the parameter shapes phase 1 unified.

```ts
/** What a filter accepts. The array form is the common case -- a fixed set of
 *  values -- and stays as it was. The function form is for values that are
 *  legal by SHAPE rather than by membership: a date, an id, a month. It
 *  returns the value to use, or null to drop the filter. */
type FilterRule = readonly string[] | ((raw: string) => string | null)
```

`parseListQuery` calls the function where one is given. Add unit tests: a valid date kept, a malformed date dropped, an injection attempt dropped, and — the one that matters — that a validator returning null leaves the filter ABSENT rather than present-and-empty.

- [ ] **Step 2: Verify the reversal join is 1:1 before choosing the count**

`listSales` has `left join transactions r on r.reverses_id = t.id`. Check:

```bash
grep -n 'transactions_reverses' db/migrations/0018_pos.sql
```

At plan time this was `UNIQUE("reverses_id")` — a transaction can have at most one reversal, so the join is 1:1 and `count(*)` is correct. Re-confirm; if the constraint is gone, use `count(distinct t.id)`.

- [ ] **Step 3-6: Tests, implement, verify, break-and-restore**

Transactions keeps its existing `?date` behaviour — the URL a user has bookmarked must keep working — now expressed as a validator rather than a hand-rolled regex on the page. Sortable: `completed_at` and `invoice_no`, both already indexed. Break-and-restore: feed the date filter a malformed value and confirm it is dropped rather than reaching SQL.

---

### Task 5: The FilterBar

**Files:**
- Create: `components/list/filter-bar.tsx`
- Modify: the six pages
- Test: `tests/e2e/customers.spec.ts` (or a shared list spec)

Phase 1 deliberately deferred this: generalising a filter control from customers' single `active` filter would have been guesswork. Six resources now exist to generalise from.

The bar renders one control per declared filter, as links through `listHref` — so filtering resets the page and preserves the sort by construction. Enum filters render as a segmented set of links; validator-backed filters (the date) render as a GET form using `preservedFields`.

⚠️ A filter set to its default must NOT appear in the URL. `?active=` on every list is noise that makes every shared link ugly and every bookmark fragile.

**Break evidence:** remove a filter's `listHref` call so it composes its own href, and watch the "filtering keeps the sort" test fail.

---

### Task 6: Correct the spec, and record what the phase learned

**Files:**
- Modify: `docs/superpowers/specs/2026-09-08-crud-standard-design.md`
- Modify: `tests/README.md`

The spec has two statements this phase proved false, and a spec that lies is worse than no spec:

1. **§3.2's table lists "stock, price" for products as if both were columns.** `stock` is derived from the `stock_on_hand` view; no index can back it. Correct the table and say so.
2. **§3.2 implies every sortable column can be indexed.** `staff` sorts on `users.name`, and `users` is not tenant-partitioned, so that sort is a join-then-sort by construction. The rule needs the exception written into it rather than discovered again.

Add to `tests/README.md` what this phase found: that `count(*)` over a join silently over-reports, that exactly one of the six resources has that shape, and that the members table's missing unique is deliberate rather than an oversight.

---

## Self-Review

**Spec coverage.** §3 contract extensions → Tasks 1 and 4. §3.2 index rule → Task 2 Step 4, with the two genuine exceptions corrected in Task 6. §3.3 tiebreaker → Task 1 (now directional). §3.4 clamp and parallel count → Tasks 2-4, each mirroring `listCustomers`. §6 UI → Tasks 2-5.

**Deferred deliberately, and tracked:** audit columns (phase 3), bulk actions and CSV export (phase 4). The `<DataTable>` wrapper stays unbuilt — six call sites now exist, so phase 3 can generalise it from evidence if the repetition proves real.

**Not covered by any task, flagged rather than hidden:** sorting products by stock level. It is the one thing a user will plausibly want that §3.2's index rule forbids, and inventing a design for it inside an implementation task would be exactly the improvisation this process exists to prevent.
