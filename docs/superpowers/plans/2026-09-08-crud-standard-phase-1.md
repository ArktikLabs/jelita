# List Contract & Query Layer (Phase 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the shared list contract (URL params → validated query → SQL fragments) and prove it on customers, the trickiest existing list query.

**Architecture:** State lives in the URL; the database sorts, filters and pages. A per-resource spec declares what is sortable, filterable and searchable; one parser is the only code that reads `searchParams` for a list. Each resource keeps its own hand-written SQL body and slots the shared fragments into it.

**Tech Stack:** Next.js 16 App Router (RSC), Drizzle `sql` templates, Postgres 17, Vitest (unit + real DB), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-08-crud-standard-design.md`

## Global Constraints

- `per` is an allow-list: **25, 50, 100, default 25**. Never a free integer.
- `sort` is **looked up** in the spec, never interpolated. Unknown → default sort.
- Every emitted `ORDER BY` ends with a **tiebreaker column** (`, <table>.id`).
- A column may only be declared `sortable` if **an index supports it**.
- Page numbers with an **exact total**; `?page=999` **clamps** to the last page.
- Count and page query run **in parallel**.
- **No new dependency.** No zod, no table library.
- `lib/` stays session-free — it is called from Vitest against a bare pool.
- Indonesian UI copy, matching the existing pages.

**Deliberate deferral:** the spec's `<DataTable>` wrapper is NOT built here. This phase builds the primitives (`preserveParams`, `<Pagination>`, `<SortableHead>`) and uses them in the existing `<Table>` markup. Generalising a table component from one call site is guesswork; phase 2 has five more and can generalise from evidence.

---

### Task 1: The list contract (pure, no database)

**Files:**
- Create: `lib/list-query.ts`
- Test: `tests/list-query.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type ListSpec`, `type ListQuery`, `type ListResult<T>`, `parseListQuery(spec, params) → ListQuery`, `orderBy(spec, query) → SQL`, `paginate(query) → SQL`, `clampPage(query, total) → ListQuery`, `toResult(rows, total, query) → ListResult<T>`.

- [ ] **Step 1: Write the failing test**

Create `tests/list-query.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { clampPage, parseListQuery, toResult, type ListSpec } from '../lib/list-query'

const SPEC: ListSpec = {
  sortable: { name: 'c.name', created: 'c.created_at' },
  defaultSort: 'name',
  tiebreak: 'c.id',
  searchable: true,
  filters: { active: ['true', 'false'] },
}

describe('parseListQuery', () => {
  it('falls back to the spec defaults when nothing is given', () => {
    const q = parseListQuery(SPEC, {})
    expect(q).toEqual({ page: 1, perPage: 25, sort: 'name', desc: false, q: null, filters: {} })
  })

  it('reads a page, a size from the allow-list, and a descending sort', () => {
    const q = parseListQuery(SPEC, { page: '3', per: '50', sort: '-created' })
    expect(q.page).toBe(3)
    expect(q.perPage).toBe(50)
    expect(q.sort).toBe('created')
    expect(q.desc).toBe(true)
  })

  it('refuses a page size that is not on the allow-list', () => {
    // A free ?per=100000 is a denial-of-service against our own database
    // written in the query string.
    expect(parseListQuery(SPEC, { per: '100000' }).perPage).toBe(25)
  })

  it('clamps a page below one', () => {
    expect(parseListQuery(SPEC, { page: '0' }).page).toBe(1)
    expect(parseListQuery(SPEC, { page: '-4' }).page).toBe(1)
    expect(parseListQuery(SPEC, { page: 'abc' }).page).toBe(1)
  })

  it('falls back to the default sort for a column that is not declared', () => {
    expect(parseListQuery(SPEC, { sort: 'salary' }).sort).toBe('name')
  })

  it('cannot be made to inject SQL, because the value is looked up not escaped', () => {
    const q = parseListQuery(SPEC, { sort: "c.name; drop table customers --" })
    expect(q.sort).toBe('name')
    // The point: the malicious string never becomes SQL because it is not a
    // key of spec.sortable. There is nothing to escape.
    expect(Object.keys(SPEC.sortable)).not.toContain("c.name; drop table customers --")
  })

  it('trims the search and treats blank as absent', () => {
    expect(parseListQuery(SPEC, { q: '  budi ' }).q).toBe('budi')
    expect(parseListQuery(SPEC, { q: '   ' }).q).toBeNull()
  })

  it('ignores a filter value that is not declared', () => {
    expect(parseListQuery(SPEC, { active: 'false' }).filters).toEqual({ active: 'false' })
    expect(parseListQuery(SPEC, { active: 'maybe' }).filters).toEqual({})
  })

  it('ignores an undeclared filter entirely', () => {
    expect(parseListQuery(SPEC, { salary: '999' }).filters).toEqual({})
  })
})

describe('clampPage', () => {
  it('pulls a page past the end back to the last page', () => {
    const q = parseListQuery(SPEC, { page: '999', per: '25' })
    expect(clampPage(q, 60).page).toBe(3)   // 60 rows / 25 = 3 pages
  })

  it('leaves an in-range page alone', () => {
    expect(clampPage(parseListQuery(SPEC, { page: '2' }), 60).page).toBe(2)
  })

  it('keeps page 1 when there are no rows at all', () => {
    expect(clampPage(parseListQuery(SPEC, { page: '4' }), 0).page).toBe(1)
  })
})

describe('toResult', () => {
  it('reports the page count, never fewer than one', () => {
    const q = parseListQuery(SPEC, {})
    expect(toResult([], 0, q).pages).toBe(1)
    expect(toResult([], 51, q).pages).toBe(3)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/list-query.test.ts`
Expected: FAIL — `Cannot find module '../lib/list-query'`.

- [ ] **Step 3: Write the implementation**

Create `lib/list-query.ts`:

```ts
import { sql, type SQL } from 'drizzle-orm'

/** Page sizes a URL may ask for. A free integer is a denial-of-service
 *  against our own database written in the query string. */
const PER_PAGE = [25, 50, 100] as const

export type ListSpec = {
  /**
   * Public sort name -> the SQL expression to order by.
   *
   * The VALUES here are written by us and never come from a request, which is
   * what makes `sql.raw` safe below. The KEYS are the entire vocabulary a URL
   * may use: anything else is not escaped, it simply does not exist.
   *
   * Spec §3.2: only declare a column here if an index supports it. This map is
   * a promise that ordering by the column is cheap.
   */
  sortable: Record<string, string>
  /** A key of `sortable`, optionally prefixed `-` for descending. */
  defaultSort: string
  /** The unique column appended to every ORDER BY. See §3.3. */
  tiebreak: string
  searchable?: boolean
  /** Filter name -> the values it accepts. Anything else is dropped. */
  filters?: Record<string, readonly string[]>
}

export type ListQuery = {
  page: number
  perPage: number
  /** A key of the spec's `sortable`. */
  sort: string
  desc: boolean
  q: string | null
  filters: Record<string, string>
}

export type ListResult<T> = {
  rows: T[]
  total: number
  page: number
  perPage: number
  pages: number
}

type Params = Record<string, string | string[] | undefined>

const one = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v

/**
 * The ONLY place a list reads searchParams.
 *
 * Everything is resolved against the spec rather than sanitised: an unknown
 * sort column, an unlisted page size and an undeclared filter are all simply
 * absent, so there is no escaping step to get wrong.
 */
export function parseListQuery(spec: ListSpec, params: Params): ListQuery {
  const rawPage = Number(one(params.page))
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1

  const rawPer = Number(one(params.per))
  const perPage = (PER_PAGE as readonly number[]).includes(rawPer) ? rawPer : PER_PAGE[0]

  const rawSort = one(params.sort) ?? spec.defaultSort
  const wanted = rawSort.startsWith('-') ? rawSort.slice(1) : rawSort
  const known = Object.hasOwn(spec.sortable, wanted)
  const fallback = spec.defaultSort.startsWith('-') ? spec.defaultSort.slice(1) : spec.defaultSort
  const sort = known ? wanted : fallback
  const desc = known ? rawSort.startsWith('-') : spec.defaultSort.startsWith('-')

  const rawQ = spec.searchable ? (one(params.q) ?? '').trim() : ''
  const q = rawQ === '' ? null : rawQ

  const filters: Record<string, string> = {}
  for (const [name, allowed] of Object.entries(spec.filters ?? {})) {
    const value = one(params[name])
    if (value !== undefined && allowed.includes(value)) filters[name] = value
  }

  return { page, perPage, sort, desc, q, filters }
}

/**
 * `sql.raw` is safe here and nowhere else: the expression comes from the
 * spec's own values, which are written in our source, and the request only
 * chose WHICH key to look up.
 *
 * The tiebreaker is not optional. `order by name` over duplicate names is not
 * deterministic between two queries, so a row can show on page 1 and again on
 * page 2 while another is never shown at all (§3.3).
 */
export function orderBy(spec: ListSpec, query: ListQuery): SQL {
  const column = spec.sortable[query.sort]
  return sql`order by ${sql.raw(column)} ${sql.raw(query.desc ? 'desc' : 'asc')}, ${sql.raw(spec.tiebreak)}`
}

export function paginate(query: ListQuery): SQL {
  return sql`limit ${query.perPage} offset ${(query.page - 1) * query.perPage}`
}

const pageCount = (total: number, perPage: number) =>
  Math.max(1, Math.ceil(total / perPage))

/** A page past the end serves the last page rather than an empty table. */
export function clampPage(query: ListQuery, total: number): ListQuery {
  const pages = pageCount(total, query.perPage)
  return query.page > pages ? { ...query, page: pages } : query
}

export function toResult<T>(rows: T[], total: number, query: ListQuery): ListResult<T> {
  return {
    rows,
    total,
    page: query.page,
    perPage: query.perPage,
    pages: pageCount(total, query.perPage),
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/list-query.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add lib/list-query.ts tests/list-query.test.ts
git commit -m "feat(list): the shared list contract

One parser is the only code that reads searchParams for a list. Sort is
resolved against an allow-list rather than escaped, so an injected column
does not exist rather than being defended against.

Every ORDER BY carries a tiebreaker: ordering by a non-unique column is not
deterministic between queries, so a row can appear on page 1 and again on
page 2 while another is never shown at all."
```

---

### Task 2: Customers returns a page

**Files:**
- Create: `db/migrations/0032_customers_list_index.sql` (0031 is the last one taken)
- Modify: `lib/customer.ts` (`listCustomers`, lines 29-46)
- Modify: `app/dashboard/(shell)/pos/page.tsx` (the other caller)
- Modify: `app/dashboard/(shell)/customers/page.tsx` (call site only; UI in Task 3)
- Test: `tests/customers.db.test.ts`

**Interfaces:**
- Consumes: `parseListQuery`, `orderBy`, `paginate`, `clampPage`, `toResult`, `ListQuery`, `ListResult` from Task 1.
- Produces: `CUSTOMER_LIST` (a `ListSpec`), and `listCustomers(organizationId, query: ListQuery) → Promise<ListResult<CustomerRow>>`.

- [ ] **Step 1: Add the index the spec promises**

`created_at` is about to be declared sortable and has no index. Spec §3.2 says a sortable column must be backed by one.

Generate it so the drizzle journal and snapshot stay in step, then replace the
body — `pnpm db:generate --custom --name customers_list_index`. The last
migration is `0031_email_parity.sql`, so this is `0032`.

Create `db/migrations/0032_customers_list_index.sql`:

```sql
-- `created` is declared sortable on the customer list, and §3.2 of the list
-- spec makes that a promise the column is cheap to order by. Without this,
-- sorting a tenant's customers by newest is a sequential scan on every page.
create index customers_org_created_idx on customers (organization_id, created_at desc, id);
```

Then run `pnpm exec tsx tests/reset-db.ts` equivalent — the DB tests rebuild the schema themselves via `tests/global-setup.ts`, so no manual step is needed for tests. For the dev database run `pnpm db:migrate`.

- [ ] **Step 2: Write the failing tests**

Append to `tests/customers.db.test.ts`:

```ts
import { listCustomers, CUSTOMER_LIST } from '../lib/customer'
import { parseListQuery } from '../lib/list-query'

describe('listCustomers paging', () => {
  const q = (params: Record<string, string> = {}) => parseListQuery(CUSTOMER_LIST, params)

  beforeAll(async () => {
    await pool.query(`delete from customers where organization_id = $1`, [ORG])
    // 60 rows, and DELIBERATELY duplicated names: a non-unique sort column is
    // what makes paging non-deterministic without a tiebreaker.
    for (let i = 0; i < 60; i++) {
      await pool.query(
        `insert into customers (id, organization_id, name, phone, phone_key)
         values ($1, $2, $3, $4, $5)`,
        [`pg_${String(i).padStart(3, '0')}`, ORG, 'Sama Persis', `08120000${String(i).padStart(3, '0')}`,
         `628120000${String(i).padStart(3, '0')}`])
    }
  })

  it('returns one page and the true total', async () => {
    const r = await listCustomers(ORG, q())
    expect(r.rows).toHaveLength(25)
    expect(r.total).toBe(60)
    expect(r.pages).toBe(3)
    expect(r.page).toBe(1)
  })

  it('pages through 60 identical names without repeating or losing one', async () => {
    // The tiebreaker test. With `order by name` alone and 60 rows called the
    // same thing, Postgres may return them in any order per query -- rows
    // repeat across pages and others are never seen.
    const seen = new Set<string>()
    for (const page of ['1', '2', '3']) {
      const r = await listCustomers(ORG, q({ page }))
      for (const row of r.rows) seen.add(row.id)
    }
    expect(seen.size, 'every row seen exactly once across three pages').toBe(60)
  })

  it('clamps a page past the end to the last page', async () => {
    const r = await listCustomers(ORG, q({ page: '999' }))
    expect(r.page).toBe(3)
    expect(r.rows).toHaveLength(10)
  })

  it('counts only the rows the search matches', async () => {
    const r = await listCustomers(ORG, q({ q: '628120000005' }))
    expect(r.total).toBe(1)
    expect(r.rows).toHaveLength(1)
  })

  it('sorts descending when asked', async () => {
    const asc = await listCustomers(ORG, q({ sort: 'created' }))
    const desc = await listCustomers(ORG, q({ sort: '-created' }))
    expect(desc.rows[0].id).not.toBe(asc.rows[0].id)
  })

  it('never returns another salon"s customers', async () => {
    await pool.query(
      `insert into customers (id, organization_id, name) values ('pg_other', $1, 'Sama Persis')`,
      [ORG2])
    const r = await listCustomers(ORG, q())
    expect(r.total).toBe(60)
    expect(r.rows.map((x) => x.id)).not.toContain('pg_other')
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm vitest run tests/customers.db.test.ts`
Expected: FAIL — `CUSTOMER_LIST` is not exported, and `listCustomers` does not accept a `ListQuery`.

- [ ] **Step 4: Rewrite `listCustomers`**

In `lib/customer.ts`, replace the existing `listCustomers` (lines 29-46) with:

```ts
import {
  clampPage, orderBy, paginate, toResult,
  type ListQuery, type ListResult, type ListSpec,
} from './list-query'

/**
 * What a URL may ask of the customer list.
 *
 * `created` is backed by customers_org_created_idx; `name` by the existing
 * (organization_id, name). Nothing else is sortable, because nothing else is
 * indexed -- see §3.2.
 */
export const CUSTOMER_LIST: ListSpec = {
  sortable: { name: 'c.name', created: 'c.created_at' },
  defaultSort: 'name',
  tiebreak: 'c.id',
  searchable: true,
  filters: { active: ['true', 'false'] },
}

/**
 * One page of a salon's customers.
 *
 * `search` matches the name or the NORMALISED number, so typing 0812 finds a
 * customer stored as +62812 -- matching the raw `phone` would miss exactly the
 * spellings normalisation exists to unify.
 *
 * The count and the page run in PARALLEL: the exact total is being paid for
 * either way, so it costs one round trip rather than two. Only an
 * out-of-range page pays for a second fetch, and nobody reaches one by
 * clicking.
 */
export async function listCustomers(
  organizationId: string, query: ListQuery,
): Promise<ListResult<CustomerRow>> {
  const term = (query.q ?? '').trim()
  // Escape LIKE metacharacters: a bare '%' would otherwise match every
  // customer in the salon rather than searching for the character.
  const like = `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
  const key = term ? normalizePhone(term) : null

  const where = sql`
    where c.organization_id = ${organizationId}
      ${term === '' ? sql`` : sql`and (
        c.name ilike ${like}
        or (${key}::text is not null and c.phone_key like ${(key ?? '') + '%'})
      )`}
      ${query.filters.active === undefined
        ? sql``
        : sql`and c.active = ${query.filters.active === 'true'}`}`

  const fetch = async (q: ListQuery) => {
    const { rows } = await db.execute(sql`
      select c.id, c.name, c.phone, c.notes, c.active
        from customers c ${where} ${orderBy(CUSTOMER_LIST, q)} ${paginate(q)}`)
    return rowsToCustomers(rows as Record<string, unknown>[])
  }

  const [rows, countRows] = await Promise.all([
    fetch(query),
    db.execute(sql`select count(*)::int as n from customers c ${where}`),
  ])
  const total = (countRows.rows[0] as { n: number }).n

  const clamped = clampPage(query, total)
  return toResult(
    clamped.page === query.page ? rows : await fetch(clamped),
    total,
    clamped,
  )
}
```

- [ ] **Step 5: Fix both call sites**

`app/dashboard/(shell)/customers/page.tsx` — replace the `listCustomers` call:

```tsx
import { parseListQuery } from '@/lib/list-query'
import { CUSTOMER_LIST, listCustomers } from '@/lib/customer'

// inside the component, replacing `const { q } = await searchParams`:
const params = await searchParams
const query = parseListQuery(CUSTOMER_LIST, params)
const customers = await listCustomers(organizationId, query)
```

and change every `customers.map` / `customers.length` to `customers.rows.…`. Widen the prop type to `searchParams: Promise<Record<string, string | string[] | undefined>>`.

`app/dashboard/(shell)/pos/page.tsx` — this is the OTHER caller and it is a picker, not a list. It wants matches for a lookup box:

```tsx
const found = q
  ? (await listCustomers(organizationId, parseListQuery(CUSTOMER_LIST, { q }))).rows
  : []
```

`parseListQuery` enforces the page-size allow-list on user input; a programmatic caller passing a bare `{ q }` gets the default 25, which is the right size for a lookup.

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run tests/customers.db.test.ts && pnpm exec tsc --noEmit`
Expected: all pass, no type errors.

- [ ] **Step 7: Run the POS suite, which exercises the picker**

Run: `E2E_PORT=3105 pnpm exec playwright test tests/e2e/pos.spec.ts --reporter=line`
Expected: 26 passed.

- [ ] **Step 8: Commit**

```bash
git add lib/customer.ts db/migrations tests/customers.db.test.ts \
  "app/dashboard/(shell)/customers/page.tsx" "app/dashboard/(shell)/pos/page.tsx"
git commit -m "feat(customers): the list returns a page, a total and a stable order

Count and page run in parallel; an out-of-range page clamps to the last one.
The order carries a tiebreaker, and the test pages through sixty identically
named customers to prove no row repeats or disappears -- which it does without
one.

created_at gains an index, because declaring a column sortable is a promise
that ordering by it is cheap."
```

---

### Task 3: The URL controls

**Files:**
- Create: `lib/list-url.ts`
- Create: `components/list/pagination.tsx`
- Create: `components/list/sortable-head.tsx`
- Modify: `app/dashboard/(shell)/customers/page.tsx`
- Test: `tests/list-url.test.ts`, `tests/e2e/customers.spec.ts`

**Interfaces:**
- Consumes: `ListQuery`, `ListResult` from Task 1; `CUSTOMER_LIST` from Task 2.
- Produces: `listHref(current, changes) → string`; `<Pagination result={…} />`; `<SortableHead column="name" label="Nama" spec={…} query={…} />`.

- [ ] **Step 1: Write the failing test for the URL helper**

Create `tests/list-url.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { listHref } from '../lib/list-url'

describe('listHref', () => {
  it('keeps the parameters it was not asked to change', () => {
    // Searching must not silently clear the filters, and sorting must not
    // clear the search. Every control goes through here for exactly this.
    const href = listHref({ q: 'budi', active: 'false', page: '2' }, { sort: '-created' })
    expect(href).toContain('q=budi')
    expect(href).toContain('active=false')
    expect(href).toContain('sort=-created')
  })

  it('resets the page whenever the result set changes', () => {
    // Otherwise the user lands on page 7 of a two-page result and sees an
    // empty table that looks like a bug.
    expect(listHref({ page: '7' }, { sort: 'name' })).not.toContain('page=')
    expect(listHref({ page: '7' }, { q: 'budi' })).not.toContain('page=')
    expect(listHref({ page: '7' }, { active: 'true' })).not.toContain('page=')
  })

  it('keeps the page when only the page changes', () => {
    expect(listHref({ q: 'budi', page: '2' }, { page: '3' })).toContain('page=3')
  })

  it('drops a parameter set to null', () => {
    expect(listHref({ q: 'budi', active: 'false' }, { active: null })).not.toContain('active')
  })

  it('returns a bare path when nothing is set', () => {
    expect(listHref({}, {})).toBe('?')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/list-url.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

Create `lib/list-url.ts`:

```ts
type Params = Record<string, string | string[] | undefined>

/**
 * Build the href for a list control.
 *
 * Every control uses this rather than composing its own query string, because
 * two rules have to hold everywhere and both are easy to forget:
 *
 *   1. Preserve the parameters you were not asked to change. A search box that
 *      drops the active filter is the classic URL-state bug.
 *   2. Reset the page whenever the RESULT SET changes -- a new sort, search or
 *      filter. Staying on page 7 of a result that now has two pages shows an
 *      empty table that reads as a broken app.
 */
export function listHref(
  current: Params,
  changes: Record<string, string | null>,
): string {
  const next = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) {
    const value = Array.isArray(v) ? v[0] : v
    if (value !== undefined && value !== '') next.set(k, value)
  }
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) next.delete(k)
    else next.set(k, v)
  }
  // Rule 2: anything but a page move invalidates the current page number.
  if (!('page' in changes)) next.delete('page')
  return `?${next.toString()}`
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run tests/list-url.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Build the two components**

Create `components/list/sortable-head.tsx`:

```tsx
import Link from 'next/link'
import { listHref } from '@/lib/list-url'
import { TableHead } from '@/components/ui/table'
import type { ListQuery, ListSpec } from '@/lib/list-query'

/**
 * A column header that sorts. A link, not a button: the state is the URL, so
 * this is navigation and the browser should treat it as such -- middle-click,
 * open in a new tab and back all work for free.
 */
export function SortableHead({
  column, label, spec, query, params,
}: {
  column: string
  label: string
  spec: ListSpec
  query: ListQuery
  params: Record<string, string | string[] | undefined>
}) {
  const isActive = query.sort === column
  // Clicking the active column flips it; clicking a new one starts ascending.
  const next = isActive && !query.desc ? `-${column}` : column
  return (
    <TableHead aria-sort={isActive ? (query.desc ? 'descending' : 'ascending') : 'none'}>
      <Link href={listHref(params, { sort: next })} className="inline-flex items-center gap-1 hover:underline">
        {label}
        <span aria-hidden className="text-muted-foreground">
          {isActive ? (query.desc ? '↓' : '↑') : ''}
        </span>
      </Link>
    </TableHead>
  )
}
```

Create `components/list/pagination.tsx`:

```tsx
import Link from 'next/link'
import { listHref } from '@/lib/list-url'
import { buttonVariants } from '@/components/ui/button'
import type { ListResult } from '@/lib/list-query'

/** "1–25 dari 4.312" plus previous/next. Rendered only when there is more
 *  than one page -- a single-page list needs no controls. */
export function Pagination({
  result, params,
}: {
  result: ListResult<unknown>
  params: Record<string, string | string[] | undefined>
}) {
  const from = (result.page - 1) * result.perPage + 1
  const to = Math.min(result.page * result.perPage, result.total)
  if (result.total === 0) return null

  return (
    <nav aria-label="Halaman" className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm text-muted-foreground tabular-nums">
        {from}–{to} dari {result.total.toLocaleString('id-ID')}
      </p>
      {result.pages > 1 && (
        <div className="flex items-center gap-2">
          {result.page > 1 && (
            <Link
              href={listHref(params, { page: String(result.page - 1) })}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              Sebelumnya
            </Link>
          )}
          <span className="text-sm text-muted-foreground tabular-nums">
            {result.page} / {result.pages}
          </span>
          {result.page < result.pages && (
            <Link
              href={listHref(params, { page: String(result.page + 1) })}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              Berikutnya
            </Link>
          )}
        </div>
      )}
    </nav>
  )
}
```

- [ ] **Step 6: Wire the customers page**

In `app/dashboard/(shell)/customers/page.tsx`: replace the plain `<TableHead>Nama</TableHead>` and `<TableHead>Nomor</TableHead>` header cells with `<SortableHead column="name" label="Nama" … />` (only `name` and `created` are sortable — leave "Nomor" and "Status" as plain heads), add `<Pagination result={customers} params={params} />` below the table, and make the empty state two distinct messages:

```tsx
<TableCell colSpan={3} className="text-muted-foreground">
  {query.q || Object.keys(query.filters).length > 0 ? (
    <>
      Tidak ada pelanggan yang cocok dengan pencarian ini.{' '}
      <Link href="/dashboard/customers" className="underline">Hapus filter</Link>
    </>
  ) : (
    'Belum ada pelanggan.'
  )}
</TableCell>
```

Keep the search `<form>`, but add a hidden input so searching does not drop the active filter:

```tsx
<form className="max-w-sm">
  {query.filters.active !== undefined && (
    <input type="hidden" name="active" value={query.filters.active} />
  )}
  <Input name="q" defaultValue={query.q ?? ''} placeholder="Cari nama atau nomor" />
</form>
```

- [ ] **Step 7: Write the end-to-end test**

Create `tests/e2e/customers.spec.ts` modelled on `tests/e2e/salon-landing.spec.ts` (same `createSalon` fixture, same `pool` cleanup). Seed 60 customers with duplicate names, then:

```ts
test('sorting keeps the search', async ({ page }) => {
  await page.context().addCookies(await ownerCookies())
  await page.goto('/dashboard/customers?q=Budi')
  await page.getByRole('link', { name: /Nama/ }).click()
  await expect(page).toHaveURL(/q=Budi/)
  await expect(page).toHaveURL(/sort=/)
})

test('searching resets the page', async ({ page }) => {
  await page.context().addCookies(await ownerCookies())
  await page.goto('/dashboard/customers?page=3')
  await page.locator('input[name="q"]').fill('Budi')
  await page.locator('input[name="q"]').press('Enter')
  await expect(page).not.toHaveURL(/page=/)
})

test('a page past the end shows the last page, not an empty table', async ({ page }) => {
  await page.context().addCookies(await ownerCookies())
  await page.goto('/dashboard/customers?page=999')
  await expect(page.locator('tbody tr')).not.toHaveCount(0)
})

test('the two empty states say different things', async ({ page }) => {
  await page.context().addCookies(await ownerCookies())
  await page.goto('/dashboard/customers?q=zzzzznotfound')
  await expect(page.getByText('Tidak ada pelanggan yang cocok')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Hapus filter' })).toBeVisible()
})
```

- [ ] **Step 8: Run everything**

Run: `pnpm vitest run && E2E_PORT=3105 pnpm exec playwright test tests/e2e/customers.spec.ts --reporter=line && pnpm build`
Expected: all green.

- [ ] **Step 9: Break-and-restore evidence**

Commit first — `git checkout HEAD -- <file>` restores to the last commit, and uncommitted work is lost otherwise. Then, one at a time, break and watch the named test fail:

| break | must fail |
|---|---|
| delete `next.delete('page')` from `listHref` | "searching resets the page" |
| drop the tiebreaker from `orderBy` | "pages through 60 identical names" |
| remove `clampPage` from `listCustomers` | "clamps a page past the end" |
| return the hidden `active` input from the search form | "sorting keeps the search" |

Restore with `git checkout HEAD -- <file>` and confirm `git status --short` is clean after each.

- [ ] **Step 10: Commit**

```bash
git add lib/list-url.ts components/list tests/list-url.test.ts tests/e2e/customers.spec.ts \
  "app/dashboard/(shell)/customers/page.tsx"
git commit -m "feat(list): URL controls — sortable headers, pagination, honest empty states

Every control builds its href through one helper, because two rules have to
hold everywhere: preserve the parameters you did not change, and reset the
page whenever the result set does. A search box that drops the active filter
is the classic version of the first; landing on page 7 of a two-page result is
the second.

The empty state is now two messages. 'No customers yet' and 'nothing matches
this search' are different problems and only one of them has a create button
as the answer."
```

---

## Self-Review

**Spec coverage.** §3 contract → Task 1. §3.1 allow-list → Task 1 tests. §3.2 index rule → Task 2 Step 1. §3.3 tiebreaker → Task 1 `orderBy` + Task 2 paging test. §3.4 clamp and parallel count → Task 1 `clampPage`, Task 2 `Promise.all`. §4 query layer keeping hand-written SQL → Task 2. §6 UI rules → Task 3.

**Deliberately not in this phase, and tracked:** §5 audit columns (phase 3), §7 bulk actions and §8 export (phase 4), the other five resources and their indexes (phase 2), and the `<DataTable>` wrapper — deferred with reasoning in Global Constraints.

**Not covered by any task, and it should be:** the spec's §6 promise of a `<FilterBar>`. Customers has exactly one filter (`active`) and it is currently rendered as a hidden input to preserve it, not as a control the user can operate. Phase 2 builds the real `<FilterBar>` when there are enough filters across resources to generalise from; until then customers can be filtered only by typing the parameter. **Flagged rather than silently dropped** — if you want the control in phase 1, it is one more task.
