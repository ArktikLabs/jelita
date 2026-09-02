# Services Catalogue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a salon a catalogue of what it sells — name, duration, price, which branches offer it, and who performs it — so booking has something to offer and POS has something to price.

**Architecture:** A salon-wide catalogue with sparse per-branch overrides. Resolution lives in a single `security_invoker` view (`service_branch_pricing`) that the app and the check suite both read, so the coalesce cannot be copy-pasted into three drifting versions. Money is an integer in the currency's minor unit, with one currency per salon on a new `salon_profiles` table.

**Tech Stack:** Next.js 16.3.3 (App Router, Turbopack), React 19.2.8, better-auth 1.7.2 + organization plugin, Drizzle ORM 0.45.2, Supabase Postgres 17.6, shadcn/ui on `@base-ui/react`.

**Spec:** `docs/superpowers/specs/2026-08-31-services-catalogue-design.md`

## Global Constraints

- **pnpm only**, and `pnpm exec`, never `npx`. Single quotes, no semicolons, 2-space indent. All UI copy in Indonesian.
- **shadcn/ui here vendors `@base-ui/react`, NOT Radix.** No `asChild`, no Slot; use the exported `buttonVariants`. Check the installed component's own types before assuming a prop exists.
- **Two guard families.** `requireUser`/`requirePermission` THROW — API routes only. `requirePageSession`/`requirePageOrg`/`requirePagePermission` REDIRECT — pages and Server Actions. Never cross them.
- **Error codes.** 403 = the role lacks permission. 402 = the tier is the blocker. 409 = a conflict the salon created. Cross-tenant reads as **not-found**, never as a leak.
- **Money is an integer in the currency's minor unit, never a decimal** (spec §2.4). `50000` is Rp 50.000 in an IDR salon and $500.00 in a USD one.
- **Every future record of money stores the amount AND the currency code** (spec §2.5). This binds booking, POS and commission, which do not exist yet.
- **`members.role` is a comma-separated list**; role tests are array overlap (`string_to_array(m.role, ',') && array['owner']`), never equality.
- **`formError(e, fallback)` returns a string**, not a FormState — wrap it as `{ error: formError(e, '...') }`.
- **Assume nothing under `lib/` is importable by a check suite until you have run it.** Node's type-stripping needs explicit file extensions on relative imports; this project has been wrong about this twice. A file with no relative imports is fine — verify, don't assume.
- **Check suites:** no framework, assert-and-count, **unconditional section-0 reset** at the START of the run. Never clean up at a section's end. A section mutating a shared `plan_limits` row restores it to the dynamically-read seeded value.
- **Dev server on port 3001. Restart by PORT only:** `lsof -ti:3001 | xargs -r kill -9`. NEVER `pkill -f 'next dev'` — it orphans the next-server child, leaving two servers on one port serving different code. This has already cost this project a day of bogus test failures.
- **Pinned suites must not move:** `auth:check` 70, `plan:check` 38, `ui:check` 16, `branch:check` 44, `staff:check` 188. `service:check` is new — count it yourself, never trust a figure in this plan.
- **Every load-bearing assertion gets break-and-restore evidence.** Five assertions in this project have passed for the wrong reason; each was caught only by breaking the code and watching. The most recent was vacuous because `FormData` normalised the input the test was trying to send.
- **Commit message trailers**, separated from the body by a blank line:

```
Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01R27c8rXsQbL9NoXfpiQUzx
```

## File Structure

| File | Responsibility |
|---|---|
| `lib/money.ts` | `SUPPORTED_CURRENCIES`, `formatMoney`, `parseMoney`. No relative imports, so a suite can load it. |
| `lib/schema/service.ts` | Drizzle declarations for the five tables |
| `db/migrations/0010_services.sql` | Tables, the additive `teams` unique, the `salon_profiles` trigger + backfill, the resolution view |
| `lib/service.ts` | `listServices`, `getService`, `resolveService`, `listPerformers` |
| `lib/plan/entitlements.ts` | The `services` branch of `countResource` |
| `app/dashboard/services/**` | List, new, detail screens + actions |
| `app/onboarding/**` | Currency choice at salon creation |
| `scripts/service-check.mjs` | The suite |

---

### Task 1: Tables, currency, and the resolution view

**Files:**
- Create: `lib/money.ts`
- Create: `lib/schema/service.ts`
- Create: `db/migrations/0010_services.sql` (0009 is the highest today)
- Modify: `lib/schema/index.ts`
- Create: `scripts/service-check.mjs`
- Modify: `package.json` (add `service:check`)

**Interfaces:**
- Produces: tables `salon_profiles`, `service_categories`, `services`, `service_branch_overrides`, `service_staff`; view `service_branch_pricing`; `SUPPORTED_CURRENCIES`, `formatMoney(minor, currency)`, `parseMoney(input, currency)`.

Covers spec §7 assertions 1, 2, 12, 13, 14.

- [ ] **Step 1: The money module**

`lib/money.ts` — **no relative imports**, so a check suite can load it directly:

```ts
/**
 * Money is an integer in the currency's minor unit (spec 2.4). The exponent
 * varies -- IDR and JPY have 0, SGD and USD have 2 -- so 50000 is Rp 50.000
 * in an IDR salon and $500.00 in a USD one. Never a decimal: commission
 * divides money, and rounding a decimal type invites half-unit drift.
 */
export const SUPPORTED_CURRENCIES = {
  IDR: { exponent: 0, locale: 'id-ID' },
  SGD: { exponent: 2, locale: 'en-SG' },
  MYR: { exponent: 2, locale: 'ms-MY' },
  USD: { exponent: 2, locale: 'en-US' },
} as const

export type CurrencyCode = keyof typeof SUPPORTED_CURRENCIES

export const isCurrencyCode = (v: string): v is CurrencyCode =>
  Object.prototype.hasOwnProperty.call(SUPPORTED_CURRENCIES, v)

/** Minor units -> a display string in the salon's locale. */
export function formatMoney(minor: number, currency: CurrencyCode): string {
  const { exponent, locale } = SUPPORTED_CURRENCIES[currency]
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(minor / 10 ** exponent)
}

/**
 * A typed amount -> minor units. Returns null when the input is not a
 * non-negative number, so callers surface a form error rather than storing
 * NaN. Digits, one separator, nothing else.
 */
export function parseMoney(input: string, currency: CurrencyCode): number | null {
  const { exponent } = SUPPORTED_CURRENCIES[currency]
  const cleaned = input.trim().replace(/[.,\s]/g, (m, i, s) =>
    exponent > 0 && s.length - i - 1 === exponent ? '.' : '')
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null
  const scaled = Math.round(Number(cleaned) * 10 ** exponent)
  return Number.isFinite(scaled) && scaled >= 0 ? scaled : null
}
```

**Verify `parseMoney` against real input before moving on** — `'150.000'` in an IDR salon must be `150000`, and `'150.50'` in a USD salon must be `15050`. If the separator heuristic misbehaves on either, simplify it to "strip every separator, then scale" and require the user to type minor units for 2-exponent currencies; say what you changed in your report. Do not ship a money parser you have not exercised.

- [ ] **Step 2: The Drizzle schema**

`lib/schema/service.ts`:

```ts
import {
  bigint, boolean, char, index, pgTable, smallint, text, timestamp, unique,
} from 'drizzle-orm/pg-core'
import { organizations, teams } from './auth'

export const salonProfiles = pgTable('salon_profiles', {
  organizationId: text('organization_id').primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  currency: char('currency', { length: 3 }).notNull().default('IDR'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const serviceCategories = pgTable('service_categories', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique('service_categories_org_id').on(t.organizationId, t.id)])

export const services = pgTable('services', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  categoryId: text('category_id'),
  name: text('name').notNull(),
  durationMinutes: smallint('duration_minutes').notNull(),
  // minor units (lib/money.ts). bigint because a 0-exponent currency puts
  // the whole rupiah figure in this column.
  price: bigint('price', { mode: 'number' }).notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('services_org_id').on(t.organizationId, t.id),
  index('services_org_idx').on(t.organizationId),
])

export const serviceBranchOverrides = pgTable('service_branch_overrides', {
  serviceId: text('service_id').notNull(),
  teamId: text('team_id').notNull(),
  organizationId: text('organization_id').notNull(),
  // null means INHERITS the salon price -- not the same as an override that
  // happens to equal it today (spec 2.1).
  price: bigint('price', { mode: 'number' }),
  offered: boolean('offered').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const serviceStaff = pgTable('service_staff', {
  serviceId: text('service_id').notNull(),
  userId: text('user_id').notNull(),
  organizationId: text('organization_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
```

The composite primary keys and composite foreign keys are declared in raw SQL in Step 4 — Drizzle's generator does not express multi-column FKs into a non-primary unique cleanly, and hand-writing them keeps the tenant guard readable.

Add `export * from './service'` to `lib/schema/index.ts`.

- [ ] **Step 3: Generate the migration**

Run: `pnpm db:generate --name services`

- [ ] **Step 4: Append the constraints, trigger, backfill and view**

Append to the generated file:

```sql
--> statement-breakpoint
-- A composite FK needs a unique constraint on the columns it references.
-- teams carries only PRIMARY KEY (id) today, so this adds the pair. It is
-- redundant against that primary key and therefore cannot reject a row
-- better-auth would otherwise write; it exists purely to be referenceable.
alter table teams add constraint teams_id_organization_id_unique
  unique (id, organization_id);
--> statement-breakpoint
alter table service_branch_overrides
  add constraint service_branch_overrides_pkey primary key (service_id, team_id);
--> statement-breakpoint
-- Cross-tenant rows are UNREPRESENTABLE, not merely filtered. An override
-- pointing at another salon's branch cannot be stored at all, rather than
-- being something every query must remember to exclude.
alter table service_branch_overrides
  add constraint sbo_service_fk foreign key (service_id, organization_id)
    references services (id, organization_id) on delete cascade,
  add constraint sbo_team_fk foreign key (team_id, organization_id)
    references teams (id, organization_id) on delete cascade;
--> statement-breakpoint
alter table service_staff
  add constraint service_staff_pkey primary key (service_id, user_id);
--> statement-breakpoint
-- staff_profiles, not members: it already carries unique (user_id,
-- organization_id) from the staff feature, and "a staff member of this salon"
-- is the more accurate target. Adding a unique to members would forbid a
-- second membership row that better-auth does not itself forbid.
alter table service_staff
  add constraint service_staff_service_fk foreign key (service_id, organization_id)
    references services (id, organization_id) on delete cascade,
  add constraint service_staff_person_fk foreign key (user_id, organization_id)
    references staff_profiles (user_id, organization_id) on delete cascade;
--> statement-breakpoint
alter table services
  add constraint services_category_fk foreign key (category_id, organization_id)
    references service_categories (id, organization_id) on delete set null;
--> statement-breakpoint
alter table services add constraint services_duration_positive
  check (duration_minutes > 0);
--> statement-breakpoint
alter table services add constraint services_price_nonnegative
  check (price >= 0);
--> statement-breakpoint
alter table service_branch_overrides add constraint sbo_price_nonnegative
  check (price is null or price >= 0);
--> statement-breakpoint
-- A duplicate name inside one salon is a 409. Case-insensitive, because
-- "Potong Rambut" and "potong rambut" are the same thing to a receptionist.
create unique index services_org_name_lower
  on services (organization_id, lower(name));
--> statement-breakpoint
-- Every salon gets settings, seeded the way branch_profiles and
-- staff_profiles are. IDR is the default because that is the launch market.
create or replace function seed_salon_profile() returns trigger
language plpgsql as $$
begin
  insert into salon_profiles (organization_id) values (new.id)
  on conflict (organization_id) do nothing;
  return new;
end $$;
--> statement-breakpoint
create trigger organizations_seed_salon_profile
  after insert on organizations
  for each row execute function seed_salon_profile();
--> statement-breakpoint
insert into salon_profiles (organization_id)
select o.id from organizations o
  left join salon_profiles p on p.organization_id = o.id
 where p.organization_id is null;
--> statement-breakpoint
-- ONE resolution, read by both the app and the check suite, so the coalesce
-- cannot be copy-pasted into three versions that drift. security_invoker
-- matches the branch_entitlement precedent.
create view service_branch_pricing with (security_invoker = true) as
select s.id as service_id, t.id as team_id, s.organization_id,
       coalesce(o.price, s.price) as price,
       (s.active and coalesce(o.offered, true)) as offered,
       s.duration_minutes, p.currency
  from services s
  join teams t on t.organization_id = s.organization_id
  join salon_profiles p on p.organization_id = s.organization_id
  left join service_branch_overrides o
    on o.service_id = s.id and o.team_id = t.id;
--> statement-breakpoint
alter table salon_profiles enable row level security;
--> statement-breakpoint
alter table service_categories enable row level security;
--> statement-breakpoint
alter table services enable row level security;
--> statement-breakpoint
alter table service_branch_overrides enable row level security;
--> statement-breakpoint
alter table service_staff enable row level security;
```

RLS enabled with zero policies, matching every other table here: the app connects as owner and bypasses.

- [ ] **Step 5: Apply it**

Run: `pnpm db:migrate`

- [ ] **Step 6: The suite, sections 0-2**

Create `scripts/service-check.mjs`:

```js
/**
 * Services catalogue checks. No framework on purpose.
 *   pnpm service:check      (dev server must be running for later sections)
 */
import { Pool } from 'pg'

let pass = 0, fail = 0
const ok = (n, c, d) => (c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${n}`))
                           : (fail++, console.log(`  \x1b[31m✗\x1b[0m ${n}  ${d ?? ''}`)))
const head = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`)

const pool = new Pool({ connectionString: process.env.DIRECT_URL })
const ORG = 'svccheck_org'
const ORG2 = 'svccheck_org2'
const ORIGIN = process.env.BETTER_AUTH_URL
const DOMAIN = 'svccheck.local'
const PW = 'demo12345'

try {
  head('0. reset test fixtures')
  // Unconditional, at the START of every run: later sections reuse fixtures
  // created by earlier ones, so cleanup never happens mid-run (a crash would
  // poison the next run) or at a section's end (a later section needs the row).
  await pool.query(`delete from organizations where slug like 'svccheck%'`)
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`])
  ok('cleared', true)

  head('1. schema')
  const { rows: tables } = await pool.query(`
    select table_name from information_schema.tables
     where table_name in ('salon_profiles','service_categories','services',
                          'service_branch_overrides','service_staff')`)
  ok('all five tables exist', tables.length === 5, `got ${tables.length}`)

  const { rows: rls } = await pool.query(`
    select relname from pg_class
     where relname in ('salon_profiles','service_categories','services',
                       'service_branch_overrides','service_staff')
       and relrowsecurity`)
  ok('RLS enabled on all five', rls.length === 5, `got ${rls.length}`)

  head('2. the trigger seeds salon settings')
  await pool.query(`
    insert into organizations (id, name, slug, created_at)
    values ($1, 'Svc Check', 'svccheck', now())`, [ORG])
  const { rows: [seeded] } = await pool.query(`
    select currency from salon_profiles where organization_id = $1`, [ORG])
  ok('a new salon gets a profile', seeded !== undefined)
  ok('defaulting to IDR', seeded?.currency === 'IDR', `got ${seeded?.currency}`)

  // spec 7.2: the backfill left nobody behind. An organization with no
  // profile row would have no currency, and every price on it unreadable.
  const { rows: [orphan] } = await pool.query(`
    select count(*)::int n from organizations o
     where not exists (select 1 from salon_profiles p
                        where p.organization_id = o.id)`)
  ok('every existing salon has a profile', orphan.n === 0, `got ${orphan.n}`)
} finally {
  await pool.end()
}

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m`)
process.exit(fail ? 1 : 0)
```

Add to `package.json` scripts:

```json
"service:check": "node --env-file=.env.local scripts/service-check.mjs",
```

- [ ] **Step 7: Assert the tenant guard is enforced by the DATABASE**

Append section 3. This is the assertion that proves spec §3.6 rather than trusting it — attempt the violation and require the write to fail:

```js
  head('3. cross-tenant rows are unrepresentable')
  await pool.query(`
    insert into organizations (id, name, slug, created_at)
    values ($1, 'Svc Check 2', 'svccheck2', now())`, [ORG2])
  await pool.query(`
    insert into teams (id, name, organization_id, created_at)
    values ('svc_t2', 'Other Branch', $1, now())`, [ORG2])
  await pool.query(`
    insert into services (id, organization_id, name, duration_minutes, price)
    values ('svc_s1', $1, 'Potong Rambut', 60, 150000)`, [ORG])

  let refused = false
  try {
    // ORG's service, ORG2's branch, ORG's organization_id -- the composite FK
    // must refuse this outright, not leave it to a WHERE clause somewhere.
    await pool.query(`
      insert into service_branch_overrides (service_id, team_id, organization_id, price)
      values ('svc_s1', 'svc_t2', $1, 99)`, [ORG])
  } catch { refused = true }
  ok('an override pointing at another salon branch is refused', refused)
```

Add the same shape for `service_staff` with a `user_id` belonging to ORG2.

- [ ] **Step 8: Assert money formatting round-trips**

Append section 4. `lib/money.ts` has no relative imports, so it should load directly — **verify that before relying on it**; if it does not, drive the formatting assertions through a page in a later task instead of asserting against a copy of the logic:

```js
  head('4. money is minor units')
  const { formatMoney, parseMoney } = await import('../lib/money.ts')
  ok('IDR has no minor digits', formatMoney(150000, 'IDR').includes('150.000'))
  ok('USD has two', formatMoney(15050, 'USD') === '$150.50', formatMoney(15050, 'USD'))
  ok('IDR parses whole units', parseMoney('150000', 'IDR') === 150000)
  ok('USD parses to cents', parseMoney('150.50', 'USD') === 15050,
     String(parseMoney('150.50', 'USD')))
  ok('a negative amount is refused', parseMoney('-5', 'IDR') === null)
```

- [ ] **Step 9: Run it, twice**

Run: `pnpm service:check && pnpm service:check`
Expected: identical counts both times, 0 failed.

- [ ] **Step 10: Prove the tenant guard assertion can fail**

Temporarily drop `sbo_team_fk`, run the suite, confirm the cross-tenant assertion FAILS (the insert now succeeds), restore the constraint, confirm it passes. Paste both outputs. A constraint nobody has watched reject something is not yet evidence.

- [ ] **Step 11: Verify nothing else moved**

Run: `pnpm exec tsc --noEmit && pnpm lint && pnpm build`
Run: `pnpm auth:check && pnpm plan:check && pnpm ui:check && pnpm branch:check && pnpm staff:check`
Expected: 70, 38, 16, 44, 188 — exactly.

- [ ] **Step 12: Commit**

```bash
git add lib/money.ts lib/schema/service.ts lib/schema/index.ts db/migrations scripts/service-check.mjs package.json
git commit -m "feat(service): catalogue tables, salon currency, and the resolution view"
```

---

### Task 2: Reads and resolution

**Files:**
- Create: `lib/service.ts`
- Modify: `scripts/service-check.mjs` (section 5)

**Interfaces:**
- Consumes: the tables and view from Task 1.
- Produces:
  - `ServiceRow = { id, name, categoryId, categoryName, durationMinutes, price, active }`
  - `listServices(organizationId, serviceId?): Promise<ServiceRow[]>`
  - `OverrideRow = { teamId, branchName, price: number | null, offered: boolean }` — `price: null` means *inherits*, and that null must survive all the way to the form field, which renders it as empty
  - `PerformerRow = { userId, name, teamId, branchName }`
  - `getService(serviceId, organizationId): Promise<{ service: ServiceRow; overrides: OverrideRow[]; performers: PerformerRow[] } | null>` — `overrides` has one entry per branch of the salon, whether or not an override row exists, so the form can render every branch; a branch with no row comes back with `price: null, offered: true`
  - `resolveService(serviceId, teamId, organizationId): Promise<{ price, currency, offered, durationMinutes } | null>`
  - `salonCurrency(organizationId): Promise<CurrencyCode>`

Covers spec §7 assertions 4, 5, 6, 7.

- [ ] **Step 1: The reads**

`lib/service.ts` — every query carries `organization_id` in the same statement, so a bare id from a form cannot cross tenants:

```ts
import { sql } from 'drizzle-orm'
import { db } from './db'
import type { CurrencyCode } from './money'

export type ServiceRow = {
  id: string
  name: string
  categoryId: string | null
  categoryName: string | null
  durationMinutes: number
  price: number
  active: boolean
}

/** Services of one salon, newest last. Pass serviceId to narrow to one. */
export async function listServices(
  organizationId: string, serviceId?: string,
): Promise<ServiceRow[]> {
  const { rows } = await db.execute(sql`
    select s.id, s.name, s.category_id, c.name as category_name,
           s.duration_minutes, s.price, s.active
      from services s
      left join service_categories c
        on c.id = s.category_id and c.organization_id = s.organization_id
     where s.organization_id = ${organizationId}
       ${serviceId === undefined ? sql`` : sql`and s.id = ${serviceId}`}
     order by c.name nulls last, s.name`)
  return (rows as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    categoryId: (r.category_id as string) ?? null,
    categoryName: (r.category_name as string) ?? null,
    durationMinutes: Number(r.duration_minutes),
    price: Number(r.price),
    active: r.active as boolean,
  }))
}

export async function salonCurrency(organizationId: string): Promise<CurrencyCode> {
  const { rows } = await db.execute(sql`
    select currency from salon_profiles where organization_id = ${organizationId}`)
  return ((rows[0] as { currency?: string })?.currency ?? 'IDR') as CurrencyCode
}
```

- [ ] **Step 2: Resolution reads the view, it does not re-implement it**

```ts
/**
 * The effective price of a service at a branch. Booking, POS and commission
 * all call this. It selects from service_branch_pricing rather than repeating
 * the coalesce -- three inline copies would drift, and the view is also what
 * scripts/service-check.mjs asserts against, so the app and the tests exercise
 * the same logic.
 */
export async function resolveService(
  serviceId: string, teamId: string, organizationId: string,
) {
  const { rows } = await db.execute(sql`
    select price, currency, offered, duration_minutes
      from service_branch_pricing
     where service_id = ${serviceId} and team_id = ${teamId}
       and organization_id = ${organizationId}`)
  const r = rows[0] as Record<string, unknown> | undefined
  if (!r) return null
  return {
    price: Number(r.price),
    currency: r.currency as CurrencyCode,
    offered: r.offered as boolean,
    durationMinutes: Number(r.duration_minutes),
  }
}
```

- [ ] **Step 3: Assertions for resolution**

Append section 5 to `scripts/service-check.mjs`, querying `service_branch_pricing` directly:

```js
  head('5. resolution')
  await pool.query(`
    insert into teams (id, name, organization_id, created_at)
    values ('svc_t1', 'Cabang Satu', $1, now())`, [ORG])
  const priceAt = async (serviceId, teamId) => {
    const { rows } = await pool.query(`
      select price, offered, currency from service_branch_pricing
       where service_id = $1 and team_id = $2`, [serviceId, teamId])
    return rows[0]
  }
  ok('no override resolves to the salon price',
     Number((await priceAt('svc_s1', 'svc_t1')).price) === 150000)

  await pool.query(`
    insert into service_branch_overrides (service_id, team_id, organization_id, price)
    values ('svc_s1', 'svc_t1', $1, 180000)`, [ORG])
  ok('an override resolves to the branch price',
     Number((await priceAt('svc_s1', 'svc_t1')).price) === 180000)

  ok('resolution carries the currency',
     (await priceAt('svc_s1', 'svc_t1')).currency === 'IDR')

  await pool.query(`
    update service_branch_overrides set offered = false
     where service_id = 'svc_s1' and team_id = 'svc_t1'`)
  ok('offered = false hides it at that branch',
     (await priceAt('svc_s1', 'svc_t1')).offered === false)

  await pool.query(`
    update service_branch_overrides set offered = true, price = null
     where service_id = 'svc_s1' and team_id = 'svc_t1'`)
  await pool.query(`update services set active = false where id = 'svc_s1'`)
  ok('an inactive service is hidden everywhere',
     (await priceAt('svc_s1', 'svc_t1')).offered === false)
  await pool.query(`update services set active = true where id = 'svc_s1'`)
```

- [ ] **Step 4: The assertion that matters most — inherits survives a round trip**

Still in section 5. Spec §2.1 turns on this distinction, and it is the one place the model can be silently corrupted:

```js
  // An override whose price EQUALS the salon price is still an override. If
  // the two collapse, a salon-wide price change silently stops reaching that
  // branch -- and nothing visible breaks until someone is charged the old
  // price months later.
  await pool.query(`
    update service_branch_overrides set price = 150000
     where service_id = 'svc_s1' and team_id = 'svc_t1'`)
  await pool.query(`update services set price = 200000 where id = 'svc_s1'`)
  ok('an override equal to the old salon price does NOT follow a salon change',
     Number((await priceAt('svc_s1', 'svc_t1')).price) === 150000,
     String((await priceAt('svc_s1', 'svc_t1')).price))

  await pool.query(`
    update service_branch_overrides set price = null
     where service_id = 'svc_s1' and team_id = 'svc_t1'`)
  ok('while an inheriting branch DOES follow it',
     Number((await priceAt('svc_s1', 'svc_t1')).price) === 200000)
```

Those two assertions are a pair: the first alone would pass against a model with no inheritance at all, and the second alone would pass against one with no overrides. Keep them together.

- [ ] **Step 5: Break and restore**

Change the view's `coalesce(o.price, s.price)` to `s.price`, re-run, confirm the override assertions fail; restore and confirm they pass. Paste both outputs.

- [ ] **Step 6: Verify and commit**

Run `pnpm service:check` twice, `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm build`, and the five pinned suites.

```bash
git add lib/service.ts scripts/service-check.mjs
git commit -m "feat(service): reads and one resolution the suite shares"
```

---

### Task 3: The plan cap

**Files:**
- Modify: `lib/plan/entitlements.ts:108` (the `return null // services, products — Task 9` line)
- Modify: `scripts/service-check.mjs` (section 6)

**Interfaces:**
- Consumes: the `services` table from Task 1.
- Produces: `countResource(orgId, 'services')` returning a number, which makes `requireQuota('services')` enforce.

Covers spec §7 assertions 8, 9.

`services` is already in `CAPPED_RESOURCES` and the caps are already seeded (free 10, starter 50). Today `countResource` returns `null` for it and `requireQuota` treats that as "not countable yet" and returns early. This task makes it count.

- [ ] **Step 1: Count active services**

Replace the `services` half of the placeholder return:

```ts
  if (resource === 'services') {
    // Active only, like staff seats and unlike branches: a retired service
    // does nothing for the salon, so it should not hold a slot. Branches
    // count even when deactivated because freeing that slot would let a salon
    // cycle branches to evade the cap; a retired service retains no such value.
    const { rows } = await db.execute(sql`
      select count(*)::int as n from services
       where organization_id = ${organizationId} and active`)
    return (rows[0] as { n: number }).n
  }
  return null // products — still uncounted
```

- [ ] **Step 2: Assertions**

Append section 6. **Prove the cap through the real path**, not with a count query — a creation that was refused must succeed after a deactivation:

```js
  head('6. the plan cap')
  // Sign in as the salon owner and create through the real action; copy the
  // sign-in and cookie-jar helper from scripts/auth-check.mjs rather than
  // inventing one -- email verification is on, and that file handles it.
```

Assertions to add:
1. With the cap set to the current count, creating another service is refused with the 402 copy, and **no service row is created** (assert the row count, not just the message).
2. Deactivating one service then re-attempting the same creation succeeds.
3. Reactivating a service while at the cap is refused with the 402 copy.

If this section mutates the shared `plan_limits` services cap, restore it to the dynamically-read seeded value at the end of the section.

- [ ] **Step 3: Break and restore**

Change the count to `where organization_id = ... and false`, confirm assertion 1 fails (the creation now succeeds), restore, confirm it passes. Paste both outputs.

- [ ] **Step 4: Verify and commit**

`plan:check` must still be exactly 38. If it moves, **investigate rather than adjust** — `requireQuota('services')` now enforces where it previously returned early, so a moved count means a plan-check assertion depended on the old no-op, which is a real finding.

```bash
git add lib/plan/entitlements.ts scripts/service-check.mjs
git commit -m "feat(service): count services against the tier cap"
```

---

### Task 4: The list and create screens

**Files:**
- Create: `app/dashboard/services/page.tsx`
- Create: `app/dashboard/services/actions.ts`
- Create: `app/dashboard/services/new/page.tsx`
- Create: `app/dashboard/services/new/service-form.tsx`
- Modify: `scripts/service-check.mjs` (section 7)

**Interfaces:**
- Consumes: `listServices`, `salonCurrency` from Task 2; `formatMoney`, `parseMoney` from Task 1.
- Produces: `createServiceAction`, `createCategoryAction` — both `(prev: FormState, formData: FormData) => Promise<FormState>`.

Covers spec §7 assertions 3, 15, 16.

Read `app/dashboard/staff/page.tsx` and `app/dashboard/staff/new/` first and follow those patterns exactly.

- [ ] **Step 1: The list**

Guarded by `requirePagePermission({ service: ['read'] })` then `requirePageOrg()`. Grouped by category, showing name, duration, price via `formatMoney`, and status. Remaining quota shown before the "Tambah layanan" button, the way the staff list does it.

**Note the guard asymmetry:** the page reads with `service: ['read']`, which front desk and stylists also hold. Spec §5.1 says they must be redirected, so the page guard is `service: ['update']` — use `update`, not `read`. Front desk reading prices belongs to POS, not here.

- [ ] **Step 2: The create action**

```ts
'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { PlanError, requireQuota } from '@/lib/plan/entitlements'
import { requirePageOrg, requirePagePermission } from '@/lib/session'
import { salonCurrency } from '@/lib/service'
import { parseMoney } from '@/lib/money'
import { formError, type FormState } from '@/lib/form-state'

export async function createServiceAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  await requirePagePermission({ service: ['create'] })
  const { organizationId } = await requirePageOrg()

  const name = String(formData.get('name') ?? '').trim()
  const duration = Number(formData.get('durationMinutes') ?? 0)
  const currency = await salonCurrency(organizationId)
  const price = parseMoney(String(formData.get('price') ?? ''), currency)

  if (!name) return { error: 'Nama layanan wajib diisi.' }
  if (!Number.isInteger(duration) || duration <= 0) {
    return { error: 'Durasi harus lebih dari 0 menit.' }
  }
  if (price === null) return { error: 'Harga tidak valid.' }

  try {
    await requireQuota('services')
    const categoryId = String(formData.get('categoryId') ?? '').trim() || null
    await db.execute(sql`
      insert into services (id, organization_id, category_id, name,
                            duration_minutes, price)
      values (${crypto.randomUUID()}, ${organizationId}, ${categoryId},
              ${name}, ${duration}, ${price})`)
  } catch (e) {
    if (e instanceof PlanError) {
      return { error: 'Kuota layanan paket Anda sudah tercapai. Upgrade untuk menambah layanan.' }
    }
    // The unique index on (organization_id, lower(name)) surfaces as a
    // constraint violation; map it rather than leaking Postgres text.
    if (e instanceof Error && /services_org_name_lower/.test(e.message)) {
      return { error: 'Layanan dengan nama ini sudah ada.' }
    }
    return { error: formError(e, 'Gagal menambah layanan.') }
  }
  revalidatePath('/services')
  redirect('/services')
}
```

- [ ] **Step 3: Categories**

`createCategoryAction` with the same guard shape, plus a small inline form on the list page. A category is name-only; deleting one is out of scope (the `on delete set null` FK already means a removed category leaves its services intact).

Note the insert above passes `categoryId` straight through without checking it belongs to this salon — that is safe **only** because the composite FK `(category_id, organization_id)` into `service_categories` makes a borrowed category unstorable. If that constraint is ever dropped, this becomes a cross-tenant hole; the assertion in Task 1 Step 7 is what keeps it honest.

- [ ] **Step 4: Assertions**

Append section 7:

1. A duplicate name in one salon is refused, **case-insensitively** — create "Potong Rambut", then attempt "potong rambut", assert the 409 copy and that no second row exists.
2. A front-desk user is redirected away from `/services` (expect a redirect, not a 200 and not a 500).
3. A stylist likewise.
4. Another salon's service id reads as not-found at `/services/<id>` and its name never appears in the response.

For assertion 4, build the other salon's service as a **complete** fixture — a real service in ORG2 with a real category — and prove the assertion has teeth by deleting the `organization_id` clause from `listServices` and watching it fail. An incomplete fixture is how three earlier assertions in this project passed for the wrong reason.

- [ ] **Step 5: Break and restore**

Make `requirePagePermission` return without redirecting, confirm assertions 2 and 3 fail, restore. Paste both outputs.

- [ ] **Step 6: Verify and commit**

```bash
git add "app/dashboard/services" scripts/service-check.mjs
git commit -m "feat(service): list and create screens"
```

---

### Task 5: The detail screen and per-branch overrides

**Files:**
- Create: `app/dashboard/services/[id]/page.tsx`
- Create: `app/dashboard/services/[id]/service-detail-forms.tsx`
- Modify: `app/dashboard/services/actions.ts`
- Modify: `scripts/service-check.mjs` (section 8)

**Interfaces:**
- Consumes: `getService` from Task 2, `listBranches` from `lib/branch.ts`.
- Produces: `updateServiceAction`, `setBranchOverrideAction`, `deactivateServiceAction`, `reactivateServiceAction`.

Covers spec §5.3 and the UI half of §7.7.

- [ ] **Step 1: The detail page**

Guarded by `service: ['update']`, loading via `getService(serviceId, organizationId)` — org-scoped in the query — and 404ing when null. Mirror `app/dashboard/staff/[id]/` in layout: separate cards per operation.

- [ ] **Step 2: The overrides card**

A row per branch with a price input and an "offered here" toggle. **An empty price field means inherits**, and the salon price shows as the input's placeholder.

```tsx
<Input
  name={`price-${b.teamId}`}
  defaultValue={o?.price === null || o === undefined ? '' : formatMoney(o.price, currency)}
  placeholder={formatMoney(service.price, currency)}
/>
```

The action must treat empty as `null` and a value as an override, **including when that value equals the salon price**:

```ts
  // Empty means INHERITS. A value equal to the salon price is still an
  // override -- collapsing the two would silently stop a salon-wide price
  // change from reaching this branch (spec 2.1).
  const raw = String(formData.get(`price-${teamId}`) ?? '').trim()
  const price = raw === '' ? null : parseMoney(raw, currency)
  if (raw !== '' && price === null) return { error: 'Harga tidak valid.' }
```

Both actions `revalidatePath('/services')` **and** `revalidatePath('/services/${id}')`. Revalidating only the list leaves the detail page stale so the operator clicks again — a bug this project has already shipped once.

- [ ] **Step 3: Deactivate and reactivate**

`deactivateServiceAction` sets `active = false`. `reactivateServiceAction` calls `requireQuota('services')` **before** flipping it back, mapping `PlanError` to the 402 copy — rehiring a service into a full plan is a 402, exactly like creating one.

- [ ] **Step 4: Assertions**

Append section 8. Drive these through the real form POST:

1. Setting a branch price equal to the salon price, then changing the salon price, leaves that branch on its own number (the §2.1 round trip, now through the UI rather than raw SQL).
2. Clearing the field returns the branch to inheriting, and it follows the next salon change.
3. Toggling "offered" off hides it at that branch and leaves other branches untouched.
4. An override naming another salon's branch is refused and writes nothing.

- [ ] **Step 5: Break and restore**

Make the action treat empty string and a value identically (always write the parsed number, defaulting to the salon price), confirm assertions 1 and 2 fail, restore. Paste both outputs.

- [ ] **Step 6: Verify and commit**

```bash
git add "app/dashboard/services" scripts/service-check.mjs
git commit -m "feat(service): detail screen and per-branch overrides"
```

---

### Task 6: Who performs a service

**Files:**
- Modify: `app/dashboard/services/[id]/page.tsx`, `service-detail-forms.tsx`, `app/dashboard/services/actions.ts`
- Modify: `lib/service.ts` (`listPerformers`)
- Modify: `scripts/service-check.mjs` (section 9)

**Interfaces:**
- Consumes: `staff_profiles` from the staff feature.
- Produces: `setPerformersAction`, `listPerformers(serviceId, organizationId)`.

Covers spec §5.3's performers card and §7.14.

- [ ] **Step 1: List candidates**

Only staff with a branch assignment are eligible — `staff_profiles.team_id is not null and active`. Spec §8 records the consequence: **a working owner cannot be linked to a service and will not be bookable.** Do not work around it here; it needs a staff-model change and is deferred deliberately.

- [ ] **Step 2: The card**

Checkboxes of eligible staff, showing each person's branch. Submitting replaces the set: delete the rows for this service that are no longer checked, insert the new ones, both scoped by `organization_id` in the statement.

- [ ] **Step 3: Assertions**

Append section 9:

1. Checking a stylist creates a `service_staff` row; unchecking removes it.
2. A staff member with no branch assignment (an admin) is **not** offered as a candidate.
3. A `service_staff` row naming another salon's user is refused **by the database** (this is spec §7.14 — attempt the insert directly and require it to fail).

- [ ] **Step 4: Verify and commit**

```bash
git add "app/dashboard/services" lib/service.ts scripts/service-check.mjs
git commit -m "feat(service): who can perform a service"
```

---

### Task 7: Currency at onboarding, and locking it

**Files:**
- Modify: `app/onboarding/actions.ts`, `app/onboarding/onboarding-form.tsx`
- Modify: `app/dashboard/services/page.tsx`, `app/dashboard/services/actions.ts`
- Modify: `scripts/service-check.mjs` (section 10)

**Interfaces:**
- Consumes: `SUPPORTED_CURRENCIES`, `isCurrencyCode` from Task 1.
- Produces: `setCurrencyAction`.

Covers spec §2.3, §2.6, §5.4 and §7.10.

- [ ] **Step 1: Choose a currency when creating the salon**

Add a currency select to the onboarding form, defaulting to `IDR`. In `createSalonAction`, after `createOrganization` succeeds, update the seeded `salon_profiles` row — the trigger has already created it, so this is an UPDATE, not an insert.

Validate with `isCurrencyCode` before writing; an unrecognised code is a form error, never a stored value.

- [ ] **Step 2: The currency card on `/services`**

While the salon has **no services at all**, render an editable card. Once any service exists, render a read-only line: the currency, and one sentence saying it is fixed because prices exist.

- [ ] **Step 3: `setCurrencyAction` refuses once priced records exist**

```ts
  // Spec 2.6: switching currency would reinterpret every stored amount by
  // orders of magnitude -- 50000 rupiah silently reading as 50000 dollars.
  // Re-denominating an operating salon is a data migration, not a settings
  // toggle. Checked in the same statement as the write so a service created
  // concurrently cannot slip past a check-then-act gap.
  const { rowCount } = await db.execute(sql`
    update salon_profiles set currency = ${currency}, updated_at = now()
     where organization_id = ${organizationId}
       and not exists (select 1 from services where organization_id = ${organizationId})`)
  if (!rowCount) return { error: 'Mata uang tidak dapat diubah setelah ada layanan berharga.' }
```

- [ ] **Step 4: Assertions**

Append section 10:

1. A salon created through onboarding with `SGD` has `SGD` in `salon_profiles`.
2. Currency is changeable while the catalogue is empty.
3. Once a service exists, the change is refused with the 409 copy and the stored currency is unchanged.
4. An unrecognised code is refused.
5. A price entered in a 2-exponent salon (SGD) stores the right minor units and renders back identically — the 100× check.

- [ ] **Step 5: Break and restore**

Remove the `not exists` clause from the UPDATE, confirm assertion 3 fails (the currency changes), restore, confirm it passes. Paste both outputs.

- [ ] **Step 6: Verify and commit**

Run `pnpm service:check` twice, `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm build`, and all five pinned suites.

```bash
git add app/onboarding "app/dashboard/services" scripts/service-check.mjs
git commit -m "feat(service): salon currency, chosen once and then fixed"
```
