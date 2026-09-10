# CRUD Standard Phase 4 — Bulk Actions and CSV Export

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every standardised list can export its current filtered view as CSV, and the four deactivatable resources can deactivate a selection in one action.

**Architecture:** Export is a GET route per resource (`/api/<resource>/csv`) because only a route can set `Content-Disposition`; it reuses the resource's existing list function with a query whose page size is raised to the export cap, so the exported rows are by construction the rows the screen would show. Bulk deactivation is a Server Action taking either explicit ids or the filter itself, resolving the filter server-side so "all 4.312 matching" never travels as 4.312 ids.

**Tech Stack:** Next.js 16.3.3 App Router, React 19.2.8, Drizzle 0.45.2 over Postgres 17, better-auth 1.7.2, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-08-crud-standard-design.md` (§7 bulk actions, §8 CSV export, §9 testing)

## Global Constraints

- **`sort` is looked up in `spec.sortable`, never interpolated.** `sql.raw` only ever receives source-authored values (§3.1).
- **Every query is scoped by `organization_id`.** A list must never return another salon's rows (§9).
- **`deleted_at` does NOT mean "hide this row".** `active` is the single truth for liveness. Never add `where deleted_at is null` (§5.1).
- **The export is capped at 10.000 rows, not streamed.** A tenant whose filter matches more gets the first 10.000, a line in the file saying so, and a notice in the UI. A silently truncated export is worse than a refused one (§8).
- **Export is governed by the list's own read permission** — the same data already on the screen. A second permission would only create a way for the two to disagree (§8).
- **Every load-bearing assertion gets break-and-restore evidence, committed before it is broken** (§9). Commit the test first, then break the source, watch it fail, `git checkout --` the source, watch it pass, confirm `git status` is clean.
- **Timestamps are the database's job, actors are the caller's** (§5.2). Every write passes the acting user.
- All user-facing copy is Indonesian, matching the surrounding pages.

## The six resources, and what each one gets

Determined from the source, not assumed. `transactions` and `products` get export only — the spec names transactions, and `products` has no `deactivateProduct` function at all (`lib/inventory.ts` exports `productsOf`, `listProducts`, `sellableProducts`, `lowStock`, `createProduct`, `recordMovement`, `moveStockForSale` and nothing else). **Do not invent one.**

| Resource | List fn | Spec const | Export guard (= its page's guard) | Bulk deactivate |
|---|---|---|---|---|
| customers | `listCustomers` | `CUSTOMER_LIST` | `{ customer: ['read'] }` | `deactivateCustomer` |
| products | `listProducts` | `PRODUCT_LIST` | `{ product: ['read'] }` | — none exists |
| services | `listServices` | `SERVICE_LIST` | `{ service: ['update'] }` | `deactivateService` |
| staff | `listStaff` | `STAFF_LIST` | `{ staff: ['read'] }` | `deactivateStaff` |
| branches | `listBranches` | `BRANCH_LIST` | `{ branch: ['update'] }` | `deactivateBranch` |
| transactions | `listTransactions` | `TRANSACTION_LIST` | `{ pos: ['checkout'] }` | — export only (§7) |

The guards are **not uniform** — services and branches gate their list pages on `update`, transactions on `pos:['checkout']`. Copy each from the resource's own `page.tsx`; do not normalise them to `read`.

## File Structure

- `lib/list-query.ts` — gains `EXPORT_CAP` and `exportQuery()`. The existing `parseListQuery` is untouched.
- `lib/list-csv.ts` — **new.** `csvResponse()`, the one place the headers, the cap notice and the filename are decided.
- `app/api/<resource>/csv/route.ts` — **new, six of them.** Each is a thin guard + column map.
- `components/list-selection.tsx` — **new.** The client island holding checkbox state and the two-mode selection.
- `lib/bulk.ts` — **new.** `resolveSelection()` turns either mode into an id list server-side; `bulkDeactivate()` runs the per-row calls and reports honestly.
- `app/dashboard/(shell)/<resource>/actions.ts` — each gains one bulk action calling `bulkDeactivate`.

---

### Task 1: The export escape hatch

`parseListQuery` clamps `perPage` to the allow-list `[25, 50, 100]` (`lib/list-query.ts:5,85`). Export needs every matching row. Phase 2's review flagged that `ListQuery.perPage` carries no trace of that allow-list, so a hand-built `{ ...query, perPage: 10000 }` at six call sites would be six chances to get the cap wrong. One function owns it instead.

**Files:**
- Modify: `lib/list-query.ts`
- Test: `tests/list-query.test.ts`

**Interfaces:**
- Consumes: `parseListQuery(spec, params)`, `type ListQuery`, `type ListSpec` — all existing.
- Produces:
  - `export const EXPORT_CAP = 10_000`
  - `export function exportQuery<K extends string>(spec: ListSpec<K>, params: Record<string, string | string[] | undefined>): ListQuery` — parses exactly as the list does, then pins `page: 1` and `perPage: EXPORT_CAP`.
  - `export const wasTruncated = (total: number) => total > EXPORT_CAP`

- [ ] **Step 1: Write the failing test**

In `tests/list-query.test.ts`:

```ts
describe('exportQuery', () => {
  it('keeps the filters and the sort the screen is showing', () => {
    const q = exportQuery(CUSTOMER_LIST, { q: 'sari', sort: '-created', active: 'true' })
    expect(q.q).toBe('sari')
    expect(q.sort).toBe('created')
    expect(q.desc).toBe(true)
    expect(q.filters.active).toBe('true')
  })

  it('raises perPage to the cap and pins page 1', () => {
    // The whole point: the screen's 25 must not become the export's 25.
    const q = exportQuery(CUSTOMER_LIST, { per: '25', page: '7' })
    expect(q.perPage).toBe(EXPORT_CAP)
    expect(q.page).toBe(1)
  })

  it('ignores an attempt to raise the cap from the URL', () => {
    // `per` is the URL key parseListQuery actually reads (lib/list-query.ts:84);
    // it is attacker-reachable, and the cap is not negotiable from a request.
    const q = exportQuery(CUSTOMER_LIST, { per: '999999' })
    expect(q.perPage).toBe(EXPORT_CAP)
  })

  it('still refuses an unknown sort, exactly as the list does', () => {
    const q = exportQuery(CUSTOMER_LIST, { sort: 'salary; drop table users' })
    expect(q.sort).toBe(CUSTOMER_LIST.defaultSort.replace('-', ''))
  })

  it('says when a result was truncated', () => {
    expect(wasTruncated(EXPORT_CAP)).toBe(false)
    expect(wasTruncated(EXPORT_CAP + 1)).toBe(true)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/list-query.test.ts`
Expected: FAIL — `exportQuery is not defined`.

- [ ] **Step 3: Implement**

In `lib/list-query.ts`, after `parseListQuery`:

```ts
/**
 * §8's cap. Not streamed: a salon with more than ten thousand matching rows
 * is not the case this product is for, and a streamed response is a different
 * shape of code to get wrong.
 *
 * ponytail: capped, not streamed. Ceiling: the 10.001st row is not exported.
 * Upgrade path: stream the response.
 */
export const EXPORT_CAP = 10_000

/**
 * The same query the screen is showing, over every matching row instead of one
 * page.
 *
 * A function rather than `{ ...query, perPage: 10_000 }` at six call sites:
 * `perPage` carries no trace of the allow-list it came from, so six copies is
 * six chances for one of them to drift.
 *
 * `page` is pinned to 1 because an offset into an un-paged result is a way to
 * silently export the wrong rows -- exporting from page 7 would skip the first
 * 60.000.
 */
export function exportQuery<K extends string>(
  spec: ListSpec<K>,
  params: Record<string, string | string[] | undefined>,
): ListQuery {
  return { ...parseListQuery(spec, params), page: 1, perPage: EXPORT_CAP }
}

/** Whether the cap actually bit, given a ListResult's `total`. */
export const wasTruncated = (total: number) => total > EXPORT_CAP
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run tests/list-query.test.ts`
Expected: PASS.

- [ ] **Step 5: Break-and-restore evidence**

Commit first, then break, then verify.

```bash
git add tests/list-query.test.ts lib/list-query.ts
git commit -m "feat(list): exportQuery, the every-matching-row escape hatch"
```

Then change `perPage: EXPORT_CAP` to `perPage: 25` and run the test — it must fail on "raises perPage to the cap". Then `git checkout -- lib/list-query.ts`, re-run to green, and confirm `git status` is clean. Record the RED output in your report.

---

### Task 2: The CSV response helper, and customers as the pilot

**Files:**
- Create: `lib/list-csv.ts`
- Create: `app/api/customers/csv/route.ts`
- Test: `tests/list-csv.test.ts`, `tests/e2e/customers.spec.ts` (append)

**Interfaces:**
- Consumes: `EXPORT_CAP`, `wasTruncated`, `exportQuery` (Task 1); `toCsv`, `csvFilename` from `lib/csv.ts`; `listCustomers(organizationId, query)`, `CUSTOMER_LIST` from `lib/customer.ts`.
- Produces:
  - `export function csvResponse(section: string, headers: string[], rows: (string | number | null)[][], total: number): Response`

`lib/csv.ts` already exists and handles the BOM, CRLF and quoting — **reuse it, do not reimplement.** Its exports are `toCsv(headers, rows)` and `csvFilename(section, from, to)`.

- [ ] **Step 1: Write the failing test**

Create `tests/list-csv.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { csvResponse } from '../lib/list-csv'
import { EXPORT_CAP } from '../lib/list-query'

const body = async (r: Response) => await r.text()

describe('csvResponse', () => {
  it('hands the browser a download, not a page', async () => {
    const r = csvResponse('pelanggan', ['Nama'], [['Sari']], 1)
    expect(r.headers.get('content-type')).toContain('text/csv')
    expect(r.headers.get('content-disposition')).toContain('attachment')
    expect(r.headers.get('content-disposition')).toContain('.csv')
    // A list is a snapshot of a moment; a cached one is a wrong one.
    expect(r.headers.get('cache-control')).toBe('no-store')
  })

  it('says so IN THE FILE when the cap bit', async () => {
    // A truncated export that looks complete is the failure this line exists
    // to prevent -- the person reading it in Excel never sees the UI notice.
    const rows = [['Sari']]
    const text = await body(csvResponse('pelanggan', ['Nama'], rows, EXPORT_CAP + 5))
    expect(text).toContain(String(EXPORT_CAP))
    expect(text.toLowerCase()).toContain('dipotong')
  })

  it('says nothing extra when it did not', async () => {
    const text = await body(csvResponse('pelanggan', ['Nama'], [['Sari']], 1))
    expect(text.toLowerCase()).not.toContain('dipotong')
    expect(text).toContain('Sari')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/list-csv.test.ts`
Expected: FAIL — cannot resolve `../lib/list-csv`.

- [ ] **Step 3: Implement the helper**

Create `lib/list-csv.ts`:

```ts
import { toCsv } from './csv'
import { EXPORT_CAP, wasTruncated } from './list-query'

/**
 * One CSV response, so the cap notice and the headers are decided once rather
 * than six times.
 *
 * The truncation notice goes IN THE FILE, not only in the UI: the person who
 * opens the spreadsheet next week never saw the screen it was downloaded from,
 * and a short export that looks complete is exactly §8's "silently truncated
 * export is worse than a refused one".
 */
export function csvResponse(
  section: string,
  headers: string[],
  rows: (string | number | null)[][],
  total: number,
): Response {
  // The notice is one more ROW in the SAME toCsv call, not a second call.
  // toCsv unconditionally prepends the BOM, so a second call injects a second
  // BOM mid-document and a phantom row containing nothing but U+FEFF -- a
  // stray blank line in Excel and a malformed record for anything stricter.
  // Padded to the header width so the record is not ragged either.
  const all = wasTruncated(total)
    ? [...rows, [
        `Dipotong pada ${EXPORT_CAP} baris dari ${total} yang cocok. ` +
        'Persempit filter untuk mengekspor sisanya.',
        ...Array(Math.max(0, headers.length - 1)).fill(null),
      ]]
    : rows
  const body = toCsv(headers, all)
  const today = new Date().toISOString().slice(0, 10)
  return new Response(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="jelita-${section}-${today}.csv"`,
      'cache-control': 'no-store',
    },
  })
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run tests/list-csv.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the customers route**

Create `app/api/customers/csv/route.ts`. Model the guard on `app/api/reports/csv/route.ts`, which is the established shape in this codebase (session → `auth.api.hasPermission` → `activeOrganizationId`).

```ts
import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { getSession } from '@/lib/session'
import { CUSTOMER_LIST, listCustomers } from '@/lib/customer'
import { exportQuery } from '@/lib/list-query'
import { csvResponse } from '@/lib/list-csv'

/**
 * §8's export. A ROUTE, not a Server Action: an action returns a value to the
 * page and cannot hand the browser a Content-Disposition.
 *
 * Guarded by customer:['read'] -- the SAME permission the list page uses, per
 * §8: this is the data already on the screen, and a second permission would
 * only create a way for the two to disagree.
 */
export async function GET(request: Request) {
  const session = await getSession()
  if (!session?.user) return new NextResponse(null, { status: 401 })

  const { success } = await auth.api.hasPermission({
    headers: await headers(),
    body: { permissions: { customer: ['read'] } },
  })
  if (!success) return new NextResponse(null, { status: 403 })

  const organizationId = session.session.activeOrganizationId
  if (!organizationId) return new NextResponse(null, { status: 404 })

  const params = Object.fromEntries(new URL(request.url).searchParams)
  const { rows, total } = await listCustomers(organizationId, exportQuery(CUSTOMER_LIST, params))

  return csvResponse('pelanggan',
    ['Nama', 'Telepon', 'Status', 'Dibuat'],
    rows.map((r) => [r.name, r.phone, r.active ? 'Aktif' : 'Nonaktif', r.createdAt]),
    total)
}
```

Check `CustomerRow`'s actual field names in `lib/customer.ts` before writing the `rows.map` — use what is there, not what this plan guessed.

- [ ] **Step 6: Add the export link to the customers page**

In `app/dashboard/(shell)/customers/page.tsx`, beside the existing filter controls, add a link that carries the current query:

```tsx
{/* The export must carry the CURRENT view, so it reuses the same
    searchParams the list was built from -- a bare /csv link would silently
    export the unfiltered table, which is the bug §8 exists to prevent. */}
<a
  href={`/api/customers/csv?${new URLSearchParams(
    Object.entries(params).filter(([, v]) => typeof v === 'string') as [string, string][],
  )}`}
  className={buttonVariants({ variant: 'outline', size: 'sm' })}
>
  Ekspor CSV
</a>
```

- [ ] **Step 7: Write the e2e assertion**

Append to `tests/e2e/customers.spec.ts`, **inside the existing `test.describe('customer search, scoping, permissions and duplicates', ...)` block at line 41** — that is where `Sari Wijaya` and `Budi Santoso` are seeded (around line 72) and where the `owner` API context lives.

Assert through the API context rather than a browser download. `Content-Disposition` and the cap notice are already covered by `csvResponse`'s unit test; what only an integration test can prove is that the route honours the screen's filter:

```ts
test('the export carries the filtered view, not the whole table', async () => {
  const res = await owner.get('/api/customers/csv?q=sari')
  expect(res.status()).toBe(200)
  const text = await res.text()
  expect(text).toContain('Sari Wijaya')
  // The one that matters: a customer the filter excluded must NOT be in the
  // file. Without this, exporting the whole table would pass.
  expect(text).not.toContain('Budi Santoso')
  // And never another salon's row, whatever the filter says.
  expect(text).not.toContain('Rahasia Salon Lain')
})
```

**Do not** use `ownerCookies()` here — it is defined only inside the *other* describe (`'the URL controls'`, line 232) and belongs to a different salon.

- [ ] **Step 8: Run and commit**

Run: `pnpm vitest run && E2E_PORT=3111 pnpm exec playwright test tests/e2e/customers.spec.ts --reporter=line`

```bash
git add lib/list-csv.ts tests/list-csv.test.ts app/api/customers/csv/route.ts \
        "app/dashboard/(shell)/customers/page.tsx" tests/e2e/customers.spec.ts
git commit -m "feat(export): CSV for the customers list, filtered view and all"
```

- [ ] **Step 9: Break-and-restore evidence**

With the commit made, break the route by dropping the params — `exportQuery(CUSTOMER_LIST, {})` — which is precisely the bug §8 exists to prevent: an export that ignores the screen's filter and hands over the whole table. Run the e2e and confirm it fails on `not.toContain('Budi Santoso')`. Then restore, confirm GREEN, and confirm `git status` is clean.

Do **not** break it by swapping `exportQuery` for `parseListQuery` — that still honours `q`, so the test would pass and prove nothing.

---

### Task 3: The remaining five export routes

Five routes of the same shape. Each is a guard, a list call, and a column map.

**Files:**
- Create: `app/api/products/csv/route.ts`, `app/api/services/csv/route.ts`, `app/api/staff/csv/route.ts`, `app/api/branches/csv/route.ts`, `app/api/transactions/csv/route.ts`
- Modify: the five corresponding `app/dashboard/(shell)/<resource>/page.tsx` to add the same "Ekspor CSV" link
- Test: `tests/list-csv.db.test.ts` (create)

**Interfaces:**
- Consumes: `csvResponse` (Task 2), `exportQuery` (Task 1), and each resource's existing `list*` function and `*_LIST` spec.

**The guards are not uniform.** Copy each from the resource's own `page.tsx`:

| Route | Permission | List fn / spec |
|---|---|---|
| products | `{ product: ['read'] }` | `listProducts` / `PRODUCT_LIST` (`lib/inventory.ts`) |
| services | `{ service: ['update'] }` | `listServices` / `SERVICE_LIST` (`lib/service.ts`) |
| staff | `{ staff: ['read'] }` | `listStaff` / `STAFF_LIST` (`lib/staff.ts`) |
| branches | `{ branch: ['update'] }` | `listBranches` / `BRANCH_LIST` (`lib/branch.ts`) |
| transactions | `{ pos: ['checkout'] }` | `listTransactions` / `TRANSACTION_LIST` (`lib/pos.ts`) |

Read each list function's row type before writing its column map. Money columns use `formatMoney(n, currency)` from `lib/money.ts` with the salon's currency from `salonSettings(organizationId)` in `lib/service.ts`, exactly as `app/api/reports/csv/route.ts` does.

**`staff` needs care:** `listStaff` returns a `role` that is a comma-joined union (`string_agg`). Export it as-is; do not take the first element.

- [ ] **Step 1: Write the failing DB test**

Create `tests/list-csv.db.test.ts`. One test per resource proving the export is tenant-scoped — the highest-value assertion here, because a leak exports another salon's whole table:

```ts
it('never exports another salon\'s rows', async () => {
  const { rows } = await listCustomers(ORG, exportQuery(CUSTOMER_LIST, {}))
  const names = rows.map((r) => r.name)
  expect(names).toContain('Sari Wijaya')
  expect(names, 'the other salon\'s customer').not.toContain('Outsider Customer')
})
```

Repeat for the other five, seeding a second organisation with one row each. Model the fixture on `tests/payroll.db.test.ts`, which already builds two organisations (`ORG`, `ORG2`).

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/list-csv.db.test.ts`
Expected: FAIL — the test file's imports resolve but the second-org fixture does not exist yet, so the assertion has nothing to exclude. Build the fixture first, watch the assertion pass, then **verify it can fail** by removing the `organization_id` predicate from one list function and confirming RED.

- [ ] **Step 3: Write the five routes**

Each follows Task 2's customers route exactly, with the permission and list function from the table above.

- [ ] **Step 4: Add the five export links**

Same `<a>` as Task 2 Step 6, in each resource's `page.tsx`.

- [ ] **Step 5: Run everything and commit**

Run: `pnpm vitest run && pnpm exec tsc --noEmit`

```bash
git add app/api tests/list-csv.db.test.ts "app/dashboard/(shell)"
git commit -m "feat(export): CSV for products, services, staff, branches and transactions"
```

- [ ] **Step 6: Break-and-restore evidence**

With the commit made, remove the `and organization_id = ...` predicate from `listProducts` and confirm the tenant-scoping test goes RED. Restore, confirm GREEN, confirm `git status` is clean.

---

### Task 4: Selection, and the two modes

§7's load-bearing distinction: **"the 25 on this page" versus "all 4.312 matching"**. The second is a deliberate second click and posts *the filter*, not four thousand ids.

**Files:**
- Create: `components/list-selection.tsx`
- Modify: `app/dashboard/(shell)/customers/page.tsx`
- Test: `tests/e2e/customers.spec.ts` (append)

**Interfaces:**
- Produces:
  - `export function SelectionProvider({ total, children }: { total: number; children: React.ReactNode })`
  - `export function SelectRow({ id }: { id: string })` — one checkbox
  - `export function SelectAll({ ids }: { ids: string[] })` — the header checkbox, selects this page
  - `export function SelectionBar({ action, label }: { action: (formData: FormData) => Promise<void>; label: string })` — the count, the "select all N matching" escalation, and the submit. **`action` is a Server Action function passed as a prop, not a URL string** — `<form action={fn}>` takes a function in the App Router.
- The form posts either `ids` (repeated) **or** `allMatching=1` plus the current filter params — never both.

- [ ] **Step 1: Write the failing e2e**

Append to `tests/e2e/customers.spec.ts`:

**The fixture must make the distinction observable.** `perPage`'s allow-list floor is 25 (`lib/list-query.ts:5`), and the customers describe seeds only two customers — so page-selection and all-matching would be identical and the test could never fail. Seed 30 in this describe's `beforeAll` first:

```ts
// 30, so "this page" (25) and "all matching" are genuinely different numbers.
// With the fixture's two customers the two modes coincide and the assertion
// below is unfalsifiable.
await pool.query(`
  insert into customers (id, organization_id, name)
  select 'e2e_bulk_' || g, $1, 'Bulk Pelanggan ' || lpad(g::text, 2, '0')
    from generate_series(1, 30) g`, [orgId])
```

```ts
test('selecting the page is not the same as selecting everything', async ({ page }) => {
  await page.context().addCookies(await ownerCookies())
  await page.goto('/dashboard/customers?perPage=25')

  await page.getByRole('checkbox', { name: 'Pilih semua di halaman ini' }).check()
  // The count must name the PAGE, not the table -- conflating them is how a
  // person deactivates four thousand rows believing they touched twenty-five.
  await expect(page.getByTestId('selection-count')).toContainText('25')

  // The escalation is a separate, deliberate click.
  await page.getByRole('button', { name: /Pilih semua .* yang cocok/ }).click()
  const count = await page.getByTestId('selection-count').textContent()
  expect(Number(count!.replace(/\D/g, ''))).toBeGreaterThan(25)
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `E2E_PORT=3111 pnpm exec playwright test tests/e2e/customers.spec.ts -g "not the same as selecting everything" --reporter=line`
Expected: FAIL — no checkbox with that name.

- [ ] **Step 3: Implement the selection island**

`components/list-selection.tsx` is `'use client'`. Selection is the one place client state is unavoidable (§7).

Hold `Set<string>` of ids plus a boolean `allMatching`. Checking the header box fills the set with this page's ids. Clicking "Pilih semua N yang cocok" sets `allMatching` and displays `total`. Any individual uncheck clears `allMatching` — a selection that claims "all matching" while one row is unchecked is a lie.

On submit, render hidden inputs: either one `ids` input per selected id, or a single `allMatching=1`. The current filter params ride along via `preservedFields` from `lib/list-url.ts`, which already exists for exactly this.

**Do not export a `KIND_LABEL`-style constant from this `'use client'` module for a server component to import** — that shipped a blank column once on this branch and was only found by screenshotting.

- [ ] **Step 4: Run it and watch it pass**

Run the same command. Expected: PASS.

- [ ] **Step 5: Commit and break-and-restore**

```bash
git add components/list-selection.tsx "app/dashboard/(shell)/customers/page.tsx" tests/e2e/customers.spec.ts
git commit -m "feat(list): page selection and the all-matching escalation"
```

Then make "Pilih semua N yang cocok" set the count to the page size instead of `total`, and confirm the test's `toBeGreaterThan(25)` goes RED. Restore, confirm GREEN, clean `git status`.

---

### Task 5: Bulk deactivation, with the guards it will actually hit

Four resources have a `deactivate*` function: customers, services, staff, branches. **Products and transactions do not get this action.**

The guards will fire in real use: `deactivateStaff` refuses to remove the last active owner (migration 0025), and it does so *in SQL*. A bulk call that reports "200 deactivated" when 199 succeeded and one was refused is exactly the dishonesty commit `2b8fe2f` fixed for role updates — follow that precedent.

**Files:**
- Create: `lib/bulk.ts`
- Modify: `app/dashboard/(shell)/customers/actions.ts`, `services/actions.ts`, `staff/actions.ts`, `branches/actions.ts`
- Test: `tests/bulk.db.test.ts` (create), `tests/e2e/customers.spec.ts` (append)

**Interfaces:**
- Consumes: `exportQuery`, `EXPORT_CAP` (Task 1); each resource's `deactivate*(id, organizationId, actorUserId)`.
- Produces:
  - `export type BulkOutcome = { done: number; refused: number; total: number }`
  - ```ts
    export async function resolveSelection<K extends string, T>(opts: {
      spec: ListSpec<K>
      params: Record<string, string | string[] | undefined>
      ids: string[]
      allMatching: boolean
      list: (q: ListQuery) => Promise<ListResult<T>>
      /** How to read the id off a row. REQUIRED, because the six row types do
       *  not agree on a name: CustomerRow/ProductRow/ServiceRow have `id`,
       *  StaffRow has `userId`, BranchRow has `teamId`. A signature assuming
       *  `{ id: string }` does not typecheck for staff or branches. */
      idOf: (row: T) => string
    }): Promise<string[]>
    ```
  - `export async function bulkDeactivate(ids: string[], run: (id: string) => Promise<boolean>): Promise<BulkOutcome>`

- [ ] **Step 1: Write the failing test**

Create `tests/bulk.db.test.ts`:

```ts
it('reports a refusal instead of counting it as done', async () => {
  // The last owner cannot be deactivated -- migration 0025 says so in SQL.
  // A bulk call must say that happened, not round it away.
  const out = await bulkDeactivate([STYLIST, LAST_OWNER],
    (id) => deactivateStaff(id, ORG, ACTOR))
  expect(out.done, 'the stylist went').toBe(1)
  expect(out.refused, 'the owner did not, and the caller is told').toBe(1)
  expect(out.total).toBe(2)
})

it('resolves "all matching" from the filter, not from ids', async () => {
  // 3 active customers match; the caller sends zero ids.
  const ids = await resolveSelection({
    spec: CUSTOMER_LIST, params: { active: 'true' }, ids: [], allMatching: true,
    list: (q) => listCustomers(ORG, q),
  })
  expect(ids).toHaveLength(3)
  expect(ids, 'and never another salon\'s row').not.toContain(OUTSIDER_CUSTOMER)
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/bulk.db.test.ts`
Expected: FAIL — cannot resolve `../lib/bulk`.

- [ ] **Step 3: Implement**

`lib/bulk.ts`:

```ts
/**
 * §7's two modes, resolved server-side.
 *
 * "All matching" posts the FILTER, not the ids: four thousand ids in a form
 * body is a request nobody should send, and one the browser may silently
 * truncate. The filter is re-run here against the same list function the
 * screen used, so what gets acted on is by construction what was shown.
 *
 * Capped at EXPORT_CAP for the same reason the export is: a bulk action over
 * more rows than that is not this product's case, and an uncapped one is an
 * unbounded statement.
 */
export async function resolveSelection<K extends string>(opts: {...}): Promise<string[]> {
  if (!opts.allMatching) return opts.ids
  const { rows } = await opts.list(exportQuery(opts.spec, opts.params))
  return rows.map(opts.idOf)
}

/**
 * Runs the per-row action, counting what actually happened.
 *
 * Each deactivate* returns false when the row was refused -- the last-owner
 * guard, an already-inactive row. Reporting those as done is the dishonesty
 * 2b8fe2f fixed for role updates: the person is told two hundred rows went
 * when one is still live, and they have no way to find which.
 */
export async function bulkDeactivate(
  ids: string[], run: (id: string) => Promise<boolean>,
): Promise<BulkOutcome> {
  let done = 0
  for (const id of ids) if (await run(id)) done++
  return { done, refused: ids.length - done, total: ids.length }
}
```

Sequential, not `Promise.all`: `deactivateStaff` takes `FOR UPDATE` locks on the owners CTE, and concurrent calls would deadlock against each other.

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run tests/bulk.db.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the four actions and the confirmation**

Each resource's action resolves the selection, calls `bulkDeactivate`, and returns a message naming both numbers when `refused > 0` — e.g. `"198 dinonaktifkan, 2 ditolak (pemilik terakhir tidak bisa dinonaktifkan)."` §7 requires the confirmation to state the count before acting, because reactivating two hundred rows one at a time is not a real undo.

- [ ] **Step 6: e2e for the honest count**

Append to `tests/e2e/customers.spec.ts` a test that selects two rows, deactivates, and asserts the page reports `2`. Then a staff test that includes the last owner and asserts the message names the refusal rather than claiming success.

- [ ] **Step 7: Run everything and commit**

Run: `pnpm vitest run && pnpm exec tsc --noEmit && E2E_PORT=3111 pnpm exec playwright test --reporter=line`

```bash
git add lib/bulk.ts tests/bulk.db.test.ts "app/dashboard/(shell)" tests/e2e
git commit -m "feat(list): bulk deactivation that reports refusals honestly"
```

- [ ] **Step 8: Break-and-restore evidence**

With the commit made, change `bulkDeactivate` to `done = ids.length` and confirm the refusal test goes RED. Restore, confirm GREEN, clean `git status`.

---

## Self-Review

**Spec coverage.** §7 bulk actions → Tasks 4 and 5 (the two modes, per-resource declaration, count confirmation, transactions excluded). §8 CSV export → Tasks 1–3 (same parameters, every matching row, `lib/csv.ts` reuse, list's own read permission, the 10.000 cap with a notice). §9 testing → the unit list is Task 1; tenant scoping is Task 3; "select all matching acts on all matching" is Task 5; "the export contains the filtered view rather than the table" is Task 2 Step 7; break-and-restore is a step in every task.

**Gap found and closed:** §9 also asks for "deleted rows absent from pickers but present in history". That is phase 2's territory and already covered by `tests/*.db.test.ts`; no task here re-does it.

**Known deviation from the spec, deliberate:** §7 says "Actions are declared per resource". This plan hard-codes four bulk-deactivate wirings rather than building a declarative action registry, because there is exactly one action and a registry for one entry is the abstraction the ladder says to skip. If a second bulk action ever lands, that is when the registry earns itself.

**Type consistency:** `exportQuery`/`EXPORT_CAP`/`wasTruncated` (Task 1) are consumed under those exact names in Tasks 2, 3 and 5. `csvResponse(section, headers, rows, total)` (Task 2) is called with that arity in Task 3. `BulkOutcome`'s fields (`done`, `refused`, `total`) are used consistently in Task 5.

**Verified since drafting:** `CustomerRow` is `{ id, name, phone, notes, active, createdAt }`, so Task 2's column map is correct as written.

**Defect found in self-review and fixed:** `resolveSelection` originally took `ListResult<{ id: string }>`. The six row types do not agree on an id field — `CustomerRow`/`ProductRow`/`ServiceRow` use `id`, `StaffRow` uses `userId`, `BranchRow` uses `teamId` — so that signature fails to compile for two of the four resources it is meant to serve. It now takes an explicit `idOf` extractor. Task 5's implementer must pass `(r) => r.userId` for staff and `(r) => r.teamId` for branches.
