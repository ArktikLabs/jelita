# A Standard for Record Lists — Design

**Date:** 2026-09-08
**Status:** draft

## 1. The problem

Ten list surfaces exist. Across all of them:

- **Nothing paginates.** `listCustomers` returns every customer, `listProducts`
  every product, `listStaff` all of them. The only `LIMIT`s in the codebase are
  three hard-coded ones inside a customer profile and the Notification Center.
- **Nothing sorts by user choice.** Every `ORDER BY` is fixed in SQL.
- **Every filter invented its own shape** — `?q` on customers, `?status` on
  notifications, `?date` on bookings, `?month` on commissions and payroll.

This already shipped a bug: the Notification Center's hard-coded `limit 100`
put every sent message past the end of the list, and it was found by going
looking for one specific row rather than by anybody noticing.

The target is a **multi-tenant SaaS at tens of thousands of rows per tenant**.
At that size the database sorts, filters and pages; nothing is loaded into the
browser to be sorted there.

## 2. Scope

**In:** customers · products · services · staff · branches · transactions —
the six surfaces that are genuinely "a list of records you browse and audit".

**Out, deliberately:** payroll and commissions are *period* views — a payroll
month IS the whole month, and a half-shown month at gajian is a footgun.
Bookings is a day. Notifications keeps its ad-hoc `?status` filter and its
`limit 100` ceiling; that bug stays open and is written down here so it is not
mistaken for an oversight.

## 3. The contract

One URL shape on all six:

```
?page=2&per=25&sort=-total&q=budi&active=false
```

`sort` carries direction as a leading `-`. One parameter, so there is no
`dir=` companion to fall out of sync with it.

`per` is an allow-list — **25, 50, 100, default 25** — not a free integer. A
free `?per=100000` is a denial-of-service against your own database written in
the query string.

Each resource declares a **spec**: sortable columns, filter definitions and
their types, whether search applies and to which fields, the legal bulk
actions, the default sort. `parseListQuery(spec, searchParams)` is the only
thing in the codebase that reads `searchParams` for a list.

### 3.1 Sort is looked up, never interpolated

`?sort=x` is resolved **against the spec's allow-list**, and a matching SQL
fragment is chosen. An unknown column is not escaped — it does not exist, and
the default sort is used. Injection is unrepresentable rather than defended
against, which is the same move the composite foreign keys and the exclusion
constraint already make.

### 3.2 A sortable column MUST be backed by an index

`sortable` is not only a security allow-list. It is a promise that the column
is cheap to order by, and at tens of thousands of rows an unindexed sort is a
sequential scan on every page load.

Today that promise would be false in several places:

| table | covered | missing |
|---|---|---|
| customers | `(org, name)` | created_at |
| products | `(org, name)`, `(org, sku)` | stock, price |
| transactions | `(org, team, completed_at)`, `(org, invoice_no)` | total |
| services | `(org, lower(name))` | a plain `name` sort will not use it |
| staff_profiles | — | **no `(org, name)` index at all** |
| teams | `(org)` | **no name index** |

So the work includes a migration adding an index for every column declared
sortable. Services either gains a plain-name index or sorts by `lower(name)`
to match the one it has.

### 3.3 Every sort carries a tiebreaker

`ORDER BY name` over duplicate names is not deterministic between two queries,
so a row can appear on page 1 and again on page 2 while another is never shown
at all. Every emitted `ORDER BY` therefore ends `, id`. With forty customers
nobody would ever see this; at the scale this design targets it is routine.

### 3.4 Paging

Page numbers with an exact total — `1–25 dari 4.312` — and a clamp: `?page=999`
on a three-page list serves page three rather than an empty table.

The count and the page run **in parallel**; the total is being paid for
anyway, so it costs one round trip rather than two. Clamping needs the total,
so an out-of-range page costs one extra query — only for a page number nobody
navigates to by clicking.

**ponytail: the exact count is a second query per page load.** Ceiling: it
grows with the tenant, and no index makes `count(*)` free. Upgrade path: cap
it (`5.000+`) or estimate from the planner. Recorded because the cost was
chosen deliberately, not missed.

## 4. The query layer

`parseListQuery` → validated `ListQuery`. Shared fragments build `ORDER BY`,
`LIMIT` and `OFFSET`. `ListResult<T>` = `{ rows, total, page, perPage, pages }`.

**Each resource keeps its own SQL body.** `listCustomers` keeps the
`phone_key` normalisation that makes typing `0812` find a number stored as
`+62812`; transactions keeps its joins. The fragments slot into the statements
that already exist. This does not become a query builder — a generator either
cannot express those queries or grows into an ORM, and the SQL in this
codebase is meant to be read.

**No new dependency.** The parser is one function over four known parameters
plus a typed filter map. `zod` earns its place validating arbitrary nested
input; this is not that, and the codebase already hand-rolls two allow-lists
that this replaces.

## 5. Audit columns

Every table in scope **already has** `created_at` and `updated_at`;
`staff_profiles` and `branch_profiles` already have a deactivation timestamp.
Only the actor columns are genuinely missing.

| table | add |
|---|---|
| customers, products, services | `created_by`, `updated_by`, `deleted_at`, `deleted_by` |
| staff_profiles, branch_profiles | `created_by`, `updated_by`, `deleted_by` + rename `deactivated_at` → `deleted_at` |
| transactions | `created_by` only |

**Transactions get nothing else.** Settled rows are immutable by trigger, so
`updated_by` would be a column that can never be written — and a column that
can never be written is a lie in the schema. Who voided a sale is already
recorded: the reversal is its own row with its own `created_by`.

### 5.1 `deleted_at` does NOT mean "hide this row"

`active` remains the single truth for "is this live". `deleted_at` and
`deleted_by` record *when* and *by whom* it stopped being offered.

This matters because the name invites the wrong query. A deactivated stylist
still owns last month's commission rows, still appears in past bookings, and
must still appear in the payroll recap for a month they worked. The flag means
**"do not offer this in pickers"**, not "pretend it never existed" — which is
exactly why `bookableBranches` filters on `active` and `listBranches` does
not. Reactivation is a first-class feature on branches, services and staff.

The name was chosen for the familiar convention (Rails, Laravel, Prisma) over
the more literal `deactivated_at`. The existing two columns are renamed so one
concept has one name.

### 5.2 Timestamps are the database's job, actors are the caller's

`created_at` defaults to `now()`. `updated_at` gets a trigger, so it cannot be
forgotten. The three `*_by` columns are **required parameters** on the lib
functions, following `recordMovement({ actorUserId })` — forgetting one is a
compile error rather than a silently null column.

This also keeps `lib/` free of the session: only `lib/session.ts` resolves a
user, and the query layer stays callable from Vitest against a bare pool. A
`SET LOCAL app.actor_id` trigger scheme would have been unforgettable, and
would have stamped NULL through every test run.

**A NULL actor is information, not absence.** A public booking has no
signed-in user; neither does the seed or the cron. NULL reads as "not created
by a signed-in person".

## 6. UI

`<DataTable>`, `<Pagination>`, `<SearchBox>`, `<FilterBar>` — all driven by the
same spec, all server-rendered, all links and GET forms.

Two rules, enforced in one `preserveParams()` helper that every control uses
rather than building its own href:

1. **Every control preserves the other parameters.** Searching must not clear
   the filters; sorting must not clear the search.
2. **Any change to sort, filter or search resets `page` to 1.** Otherwise the
   user lands on page 7 of a two-page result and sees nothing.

Empty states are two different messages: *"Belum ada pelanggan"* with a create
action, versus *"Tidak ada yang cocok dengan filter ini"* with a clear-filters
link. Today neither exists and both read as the same blank table.

## 7. Bulk actions

Selection is the one place client state is unavoidable.

The load-bearing distinction is **"the 25 on this page" versus "all 4.312
matching"**. The second is a deliberate second click, and it posts *the
filter*, not four thousand ids.

Actions are declared per resource and permission-checked individually.
`transactions` gets export only. Bulk deactivation confirms with the count,
because reactivating two hundred rows one at a time is not a real undo.

## 8. CSV export

`/api/<resource>/csv` taking the same parameters, exporting the current
filtered and sorted view — every matching row, not the current page. Reuses
`lib/csv.ts` for the BOM, CRLF and quoting that make Excel open it correctly.

Governed by the list's own read permission: it is the same data already on the
screen, and a second permission would only create a way for the two to
disagree.

**ponytail: the export is capped at 10.000 rows, not streamed.** Ceiling: a
tenant whose filter matches more gets the first 10.000 and a line in the file
plus a notice in the UI saying so — a silently truncated export is worse than
a refused one. Upgrade path: stream the response.

## 9. Testing

Unit, no database: clamping · an unknown `sort` falling back to the default ·
an injection attempt resolving to the default · the per-page allow-list · page
reset on filter change.

Against real Postgres: totals under filters · tenant scoping, so a list can
never return another salon's rows · deleted rows absent from pickers but
**present in history** · and the tiebreaker test — page through a table of
duplicate names and assert every row was seen exactly once.

End to end: sorting preserves the filters · searching preserves them · page
999 clamps · "select all matching" acts on all matching rather than the
visible page · the export contains the filtered view rather than the table.

**Every load-bearing assertion gets break-and-restore evidence**, committed
before it is broken.


## 10. Sequencing

This is more than one implementation plan's worth, and the pieces are
genuinely independent. The natural order, each shippable on its own:

1. **The contract, the query layer, and one pilot resource.** Customers —
   it already has search, so it exercises parsing, paging, sorting and
   filtering against the trickiest existing query. Nothing else changes until
   this is right.
2. **The remaining five resources**, plus the index migration that makes their
   declared sortable columns honest.
3. **Audit columns** — independent of everything above, and safe to land
   before or after. Includes the `deactivated_at` → `deleted_at` rename across
   the eleven existing sites.
4. **Bulk actions and CSV export** — both build on the finished contract, and
   neither is needed for the lists to be usable.

Phase 1 is the one that carries risk; the rest is repetition of a shape that
by then has been proven once.
