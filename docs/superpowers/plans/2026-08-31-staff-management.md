# Staff Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an owner or admin run their roster — see who works where, hire, transfer, change roles, reset forgotten passwords, record departures, and bulk-import — with the plan's seat cap enforced throughout.

**Architecture:** A new `staff_profiles` table becomes the single authority on who works at which branch, replacing the `isStaff` role filter that branch deactivation currently uses. better-auth's `team_members` keeps its navigational job (the session hook reads it to resolve `activeTeamId`). Provisioning logic moves out of the existing API route into `lib/staff.ts`, shared by the route and the new Server Actions.

**Tech Stack:** Next.js 16.3.3 (App Router, Turbopack), React 19.2.8, better-auth 1.7.2 + organization plugin, Drizzle ORM 0.45.2, Supabase Postgres 17.6, shadcn/ui on `@base-ui/react`.

**Spec:** `docs/superpowers/specs/2026-08-31-staff-management-design.md`

## Global Constraints

- **pnpm only.** Never npm or yarn.
- **Style:** single quotes, no semicolons, 2-space indent. All UI copy in Indonesian.
- **shadcn/ui here vendors `@base-ui/react`, NOT Radix.** There is no `asChild` and no Slot. Check the installed component's own types before assuming a prop exists.
- **Two guard families.** `requireUser`/`requirePermission` THROW — for API routes. `requirePageSession`/`requirePageOrg`/`requirePagePermission` REDIRECT — for pages and Server Actions. Never cross them.
- **Error codes.** 403 = the role lacks permission. 402 = the tier is the blocker. 409 = a conflict the salon created. When a branch is both closed and locked, **closed wins** — matching `getBranchStatus`.
- **`members.role` is a comma-separated list.** better-auth splits it on `,` in `hasPermissionFn`. Any role test is array overlap, never equality: `string_to_array(m.role, ',') && array['owner']`.
- **`lib/plan/*.ts` must stay importable by plain Node type-stripping** — no classes, no importing `../session`. The check suites load those files directly.
- **Check suites:** no framework, assert-and-count, and an **unconditional section-0 fixture reset** at the START of the run. Never clean up at a section's end — a later section still needs the row, and a crash would poison the next run.
- **If a section mutates a shared `plan_limits` row, restore it to the seeded value at the end of that section.**
- **Dev server runs on port 3001. Restart by PORT only:** `lsof -ti:3001 | xargs -r kill -9`. NEVER `pkill -f 'next dev'` — it orphans the `next-server` child, leaving two servers on one port serving different code. This has already cost this project a day of bogus test failures.
- **Server Actions using `next/headers` cannot be invoked from a standalone Node script.** Drive them through the running dev server.
- **Pinned suites must not move:** `pnpm auth:check` exactly 70, `pnpm plan:check` exactly 38, `pnpm ui:check` exactly 16, `pnpm branch:check` exactly 44. `staff:check` is new and grows each task — count it yourself, never trust a figure in this plan.
- **Every load-bearing assertion gets break-and-restore evidence:** break the production code, watch that specific assertion fail, restore, watch it pass. Three of the branch feature's rules went unasserted and those were exactly the three that were broken.
- **Work records carry their own `branch_id`** (spec §2.2). No booking, commission line or payroll entry may derive its branch from the staff member who performed it. Nothing in this plan writes such a record, but this is the feature that creates the temptation: inferring the branch from the person makes multi-branch cover unaffordable later, because historical work becomes unreconstructable rather than merely needing a refactor.
- **Commit message trailers**, separated from the body by a blank line:

```
Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01R27c8rXsQbL9NoXfpiQUzx
```

## File Structure

| File | Responsibility |
|---|---|
| `lib/schema/staff.ts` | Drizzle declaration of `staff_profiles` |
| `db/migrations/00NN_staff_profiles.sql` | Table, trigger on `members`, backfill |
| `lib/staff.ts` | Provisioning, assignment queries, departure. Owns the profile + `team_members` write pair. |
| `lib/plan/entitlements.ts` | `countResource('staff')` counts active profiles |
| `lib/branch.ts` | `assignedStaff` / `listBranches` read `staff_profiles`; `isStaff` deleted |
| `app/api/staff/route.ts` | Delegates to `lib/staff.ts` |
| `lib/session.ts` | Deactivated logins are refused |
| `app/(app)/staff/**` | List, new, detail, import screens + actions |
| `scripts/staff-check.mjs` | The suite |

---

### Task 1: `staff_profiles`, its trigger, and seat counting

**Files:**
- Create: `lib/schema/staff.ts`
- Create: `db/migrations/00NN_staff_profiles.sql` (NN = next number; `0008` is the highest today)
- Modify: `lib/schema/index.ts`
- Modify: `lib/plan/entitlements.ts` (the `staff` branch of `countResource`)
- Create: `scripts/staff-check.mjs`
- Modify: `package.json` (add the `staff:check` script)

**Interfaces:**
- Produces: table `staff_profiles (user_id, organization_id, team_id, active, deactivated_at, created_at, updated_at)` with `unique (user_id, organization_id)`; trigger `members_seed_staff_profile`; `countResource('staff')` counting active profiles.

Covers spec §7 assertions 1, 2, 3.

- [ ] **Step 1: Declare the table**

`lib/schema/staff.ts`:

```ts
import { boolean, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core'
import { organizations, teams, users } from './auth'

export const staffProfiles = pgTable('staff_profiles', {
  userId: text('user_id').notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  organizationId: text('organization_id').notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  // null for owner and admin: they are salon-wide, not assigned to a branch.
  teamId: text('team_id').references(() => teams.id, { onDelete: 'set null' }),
  active: boolean('active').notNull().default(true),
  deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique('staff_profiles_one_branch').on(t.userId, t.organizationId)])
```

Add `export * from './staff'` to `lib/schema/index.ts`.

`onDelete: 'set null'` on `team_id`, not cascade: deleting a branch must never silently delete the employment record of everyone who worked there.

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate --name staff_profiles`

- [ ] **Step 3: Append the trigger and backfill to the generated file**

The generator does not emit triggers. Append this to the file it just wrote:

```sql
--> statement-breakpoint
-- Every member of a salon gets a profile, the owner included: the seat cap
-- counts members, so if only assigned staff had rows, owners and admins would
-- silently stop counting and every salon's effective allowance would jump.
-- The trigger cannot know a branch (better-auth's addMember writes the
-- team_members row separately), so it seeds team_id null and lib/staff.ts
-- fills it in.
create or replace function seed_staff_profile() returns trigger
language plpgsql as $$
begin
  insert into staff_profiles (user_id, organization_id)
  values (new.user_id, new.organization_id)
  on conflict (user_id, organization_id) do nothing;
  return new;
end $$;
--> statement-breakpoint
create trigger members_seed_staff_profile
  after insert on members
  for each row execute function seed_staff_profile();
--> statement-breakpoint
insert into staff_profiles (user_id, organization_id)
select m.user_id, m.organization_id from members m
  left join staff_profiles s
    on s.user_id = m.user_id and s.organization_id = m.organization_id
 where s.user_id is null;
--> statement-breakpoint
-- Carry existing assignments across. A non-management member with a
-- team_members row in this salon was working at that branch; losing that on
-- migration would silently empty every roster. Deterministic pick so the
-- migration is reproducible.
update staff_profiles s
   set team_id = (
     select tm.team_id from team_members tm
       join teams t on t.id = tm.team_id
      where tm.user_id = s.user_id and t.organization_id = s.organization_id
      order by tm.created_at, tm.team_id limit 1)
 where s.team_id is null
   and exists (
     select 1 from members m
      where m.user_id = s.user_id and m.organization_id = s.organization_id
        and not (string_to_array(m.role, ',') && array['owner', 'admin']));
--> statement-breakpoint
alter table staff_profiles enable row level security;
```

RLS enabled with zero policies, matching every other table here: the app connects as owner and bypasses.

- [ ] **Step 4: Apply it**

Run: `pnpm db:migrate`

- [ ] **Step 5: Change seat counting**

In `lib/plan/entitlements.ts`, replace the body of the `staff` branch of `countResource`:

```ts
  if (resource === 'staff') {
    // Counts members who can actually work. A departed stylist releases their
    // seat (spec §2.4); the owner keeps theirs. coalesce(..., true) so a member
    // with no profile row still counts -- a missing row must never silently
    // hand out a free seat.
    const { rows } = await db.execute(sql`
      select count(*)::int as n from members m
       where m.organization_id = ${organizationId}
         and coalesce((select s.active from staff_profiles s
                        where s.user_id = m.user_id
                          and s.organization_id = m.organization_id), true)`)
    return (rows[0] as { n: number }).n
  }
```

- [ ] **Step 6: Write the suite with its first assertions**

Create `scripts/staff-check.mjs`:

```js
/**
 * Staff management checks. No framework on purpose.
 *   pnpm staff:check      (dev server must be running for later sections)
 */
import { Pool } from 'pg'

let pass = 0, fail = 0
const ok = (n, c, d) => (c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${n}`))
                           : (fail++, console.log(`  \x1b[31m✗\x1b[0m ${n}  ${d ?? ''}`)))
const head = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`)

const pool = new Pool({ connectionString: process.env.DIRECT_URL })
const ORG = 'staffcheck_org'
const ORG2 = 'staffcheck_org2'
const ORIGIN = process.env.BETTER_AUTH_URL
const DOMAIN = 'staffcheck.local'
const PW = 'demo12345'

try {
  head('0. reset test fixtures')
  // Unconditional, at the START of every run: later sections reuse fixtures
  // created by earlier ones, so cleanup never happens mid-run (a crash would
  // poison the next run) or at a section's end (a later section needs the row).
  await pool.query(`delete from organizations where id = any($1)`, [[ORG, ORG2]])
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`])
  ok('cleared', true)

  head('1. schema')
  const { rows: [tbl] } = await pool.query(`
    select count(*)::int n from information_schema.tables
     where table_name = 'staff_profiles'`)
  ok('staff_profiles exists', tbl.n === 1)

  const { rows: [rls] } = await pool.query(`
    select relrowsecurity from pg_class where relname = 'staff_profiles'`)
  ok('RLS enabled', rls.relrowsecurity === true)

  // spec 7.1: one branch each is enforced by the SCHEMA, not by app code.
  // Asserted by attempting the violation, not by reading the catalogue -- a
  // constraint that exists but is deferrable or NOT VALID would still pass a
  // catalogue check while allowing the write.
  await pool.query(`
    insert into organizations (id, name, slug, created_at)
    values ($1, 'Staff Check 2', 'staffcheck2', now())`, [ORG2])
  await pool.query(`
    insert into users (id, name, email, email_verified, created_at, updated_at)
    values ('sc_dup', 'SC Dup', $1, true, now(), now())`, [`dup@${DOMAIN}`])
  await pool.query(`
    insert into staff_profiles (user_id, organization_id) values ('sc_dup', $1)`, [ORG2])
  let refused = false
  try {
    await pool.query(`
      insert into staff_profiles (user_id, organization_id) values ('sc_dup', $1)`, [ORG2])
  } catch { refused = true }
  ok('a second profile for one person in one salon is refused', refused)

  // spec 7.2: the backfill left nobody behind. Any member without a profile
  // would silently count as a seat forever (countResource fails open).
  const { rows: [orphan] } = await pool.query(`
    select count(*)::int n from members m
     where not exists (select 1 from staff_profiles s
                        where s.user_id = m.user_id
                          and s.organization_id = m.organization_id)`)
  ok('every existing member has a profile', orphan.n === 0)

  head('2. the trigger seeds a profile for every member')
  await pool.query(`
    insert into organizations (id, name, slug, created_at)
    values ($1, 'Staff Check', 'staffcheck', now())`, [ORG])
  await pool.query(`
    insert into users (id, name, email, email_verified, created_at, updated_at)
    values ('sc_owner', 'SC Owner', $1, true, now(), now())`,
    [`owner@${DOMAIN}`])
  await pool.query(`
    insert into members (id, user_id, organization_id, role, created_at)
    values ('sc_m_owner', 'sc_owner', $1, 'owner', now())`, [ORG])

  const { rows: [seeded] } = await pool.query(`
    select active, team_id from staff_profiles
     where user_id = 'sc_owner' and organization_id = $1`, [ORG])
  ok('a new member gets a profile', seeded !== undefined)
  ok('seeded active, with no branch', seeded?.active === true && seeded?.team_id === null)

  head('3. seat counting')
  const { countResource } = await import('../lib/plan/entitlements.ts')
  ok('the owner consumes a seat', await countResource(ORG, 'staff') === 1)
} finally {
  await pool.end()
}

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m`)
process.exit(fail ? 1 : 0)
```

Add to `package.json` scripts:

```json
"staff:check": "node --env-file=.env.local scripts/staff-check.mjs",
```

- [ ] **Step 7: Run it, twice**

Run: `pnpm staff:check && pnpm staff:check`
Expected: identical counts both times, 0 failed. Two identical runs prove the section-0 reset makes it idempotent.

- [ ] **Step 8: Prove the seat assertion can fail**

Temporarily add `and false` to the `where` clause of the `countResource` query from Step 5, so it always returns 0. Run `pnpm staff:check`. Expected: "the owner consumes a seat" FAILS. Restore, run again, confirm it passes. Paste both outputs into your report.

An assertion nobody has watched fail is not yet evidence.

- [ ] **Step 9: Verify nothing else moved**

Run: `npx tsc --noEmit && pnpm lint && pnpm build`
Run: `pnpm auth:check && pnpm plan:check && pnpm ui:check && pnpm branch:check`
Expected: 70, 38, 16, 44 — exactly. `plan:check` exercises `countResource('staff')`, so a regression there shows up here.

- [ ] **Step 10: Commit**

```bash
git add lib/schema/staff.ts lib/schema/index.ts db/migrations lib/plan/entitlements.ts scripts/staff-check.mjs package.json
git commit -m "feat(staff): profiles table, seeded per member, and seat counting"
```

---

### Task 2: `lib/staff.ts`, extracted from the API route

**Files:**
- Create: `lib/staff.ts`
- Modify: `app/api/staff/route.ts`
- Modify: `scripts/staff-check.mjs` (new section 4)

**Interfaces:**
- Consumes: `staff_profiles` from Task 1.
- Produces:
  - `provisionStaff({ organizationId, name, email, password, role, teamId }): Promise<{ userId: string }>`
  - `listStaff(organizationId): Promise<StaffRow[]>` where `StaffRow = { userId, name, email, role, teamId, branchName, active }`
  - `getStaff(userId, organizationId): Promise<StaffRow | null>`

This is a **refactor with no behaviour change**. `auth:check` must stay at exactly 70 across it.

- [ ] **Step 1: Move provisioning into `lib/staff.ts`**

Create `lib/staff.ts` containing the logic currently inline in `app/api/staff/route.ts`, unchanged in behaviour. Keep both load-bearing comments — they encode why the code looks unusual:

```ts
import { createLocalAccountIssuer } from 'better-auth'
import { sql } from 'drizzle-orm'
import { auth } from './auth'
import { db } from './db'
import { roles, type SalonRole } from './permissions'
import { requireQuota } from './plan/entitlements'

export type StaffRow = {
  userId: string
  name: string
  email: string
  role: string
  teamId: string | null
  branchName: string | null
  active: boolean
}

export async function provisionStaff(input: {
  organizationId: string
  name: string
  email: string
  password: string
  role: SalonRole
  teamId?: string | null
}): Promise<{ userId: string }> {
  if (!(input.role in roles)) throw new Error('UNKNOWN_ROLE')
  await requireQuota('staff')

  // Create the login directly instead of via signUpEmail: that endpoint mints
  // a session, and nextCookies() would then write the NEW user's session
  // cookie onto this response -- logging the owner in as the staff member they
  // just created. Building the user + credential account by hand creates no
  // session at all.
  const ctx = await auth.$context
  const email = input.email.toLowerCase()
  if (await ctx.internalAdapter.findUserByEmail(email)) throw new Error('EMAIL_TAKEN')

  const hash = await ctx.password.hash(input.password)
  // Verified true, not false: this account never goes through
  // sendVerificationEmail at all, so requireEmailVerification would lock the
  // new hire out of sign-in forever. The owner creating the login IS the
  // verification.
  const created = await ctx.internalAdapter.createUser(
    { email, name: input.name, emailVerified: true },
    { method: 'email-password' },
  )
  await ctx.internalAdapter.linkAccount({
    userId: created.id,
    providerId: 'credential',
    issuer: createLocalAccountIssuer('credential'),
    accountId: created.id,
    password: hash,
  })

  await auth.api.addMember({
    body: {
      userId: created.id,
      organizationId: input.organizationId,
      role: input.role,
      ...(input.teamId ? { teamId: input.teamId } : {}),
    },
  })

  // The members insert fired the trigger, so a profile exists with team_id
  // null. Assignment is this module's job -- see the pairing note below.
  if (input.teamId) await assignBranch(created.id, input.organizationId, input.teamId)
  return { userId: created.id }
}
```

- [ ] **Step 2: Add the write pair, in one place**

Still in `lib/staff.ts`:

```ts
/**
 * Assignment is TWO rows and they must never drift.
 *
 *   staff_profiles.team_id  -- who works here (this app's authority)
 *   team_members            -- navigational; the session hook reads it to
 *                              resolve activeTeamId on login (lib/auth.ts),
 *                              and setActiveTeam refuses a user without it
 *
 * Every write of either goes through this function so the pair is atomic in
 * intent. scripts/staff-check.mjs asserts they never diverge.
 */
export async function assignBranch(
  userId: string, organizationId: string, teamId: string | null,
) {
  await db.execute(sql`
    update staff_profiles set team_id = ${teamId}, updated_at = now()
     where user_id = ${userId} and organization_id = ${organizationId}
       and (${teamId}::text is null or exists (
         select 1 from teams where id = ${teamId}
           and organization_id = ${organizationId}))`)
  if (teamId) {
    await auth.api.addTeamMember({
      body: { teamId, userId, organizationId },
      headers: new Headers(),
    })
  }
}
```

The `exists` clause carries the org scoping **inside the same statement**, so a bare `teamId` from a form can never assign someone into another salon's branch.

- [ ] **Step 3: Add the read queries**

```ts
/** Staff of one salon. Pass userId to narrow to one; the org scoping is in
 *  the query either way, so a bare id from the client cannot cross tenants. */
export async function listStaff(
  organizationId: string, userId?: string,
): Promise<StaffRow[]> {
  const { rows } = await db.execute(sql`
    select u.id as user_id, u.name, u.email, m.role,
           s.team_id, t.name as branch_name, s.active
      from members m
      join users u on u.id = m.user_id
      left join staff_profiles s
        on s.user_id = m.user_id and s.organization_id = m.organization_id
      left join teams t on t.id = s.team_id
     where m.organization_id = ${organizationId}
       ${userId === undefined ? sql`` : sql`and u.id = ${userId}`}
     order by u.name, u.id`)
  return (rows as Record<string, unknown>[]).map((r) => ({
    userId: r.user_id as string,
    name: r.name as string,
    email: r.email as string,
    role: r.role as string,
    teamId: (r.team_id as string) ?? null,
    branchName: (r.branch_name as string) ?? null,
    active: (r.active as boolean) ?? true,
  }))
}

export async function getStaff(userId: string, organizationId: string) {
  const [row] = await listStaff(organizationId, userId)
  return row ?? null
}
```

- [ ] **Step 4: Make the route delegate**

Rewrite `app/api/staff/route.ts`'s try-block body to call `provisionStaff`, keeping the existing `STATUS` map, the `PlanError` → 402 handling, and the 400s for `INVALID_JSON` / `MISSING_FIELDS` / `UNKNOWN_ROLE` exactly as they are. The route keeps `requirePermission({ staff: ['create'] })` — the THROWING guard, because it is an API route.

- [ ] **Step 5: Prove the refactor changed nothing**

Run: `pnpm auth:check`
Expected: exactly `70 passed, 0 failed`. This suite already exercises the route end to end, including the "provisioning must not hijack the caller's session" case.

- [ ] **Step 6: Assert the write pair**

Append section 4 to `scripts/staff-check.mjs`, creating a stylist through the route and asserting both rows exist and agree:

```js
  head('4. provisioning writes the assignment pair')
  const call = (path, body, cookie) => fetch(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body ?? {}),
  })
  // (sign in as the owner first -- copy the sign-in + cookie-jar helper from
  // scripts/auth-check.mjs rather than inventing one; email verification is on,
  // and that file already handles it.)
```

The implementer writes the sign-in helper by copying the working pattern from `scripts/auth-check.mjs`. Assertions to add:

1. Creating a stylist with a `branchId` produces a `staff_profiles` row with that `team_id`.
2. The same call produces a `team_members` row for the same `(user, team)`.
3. Creating an admin with no branch leaves `team_id` null.

- [ ] **Step 7: Verify and commit**

Run: `pnpm staff:check && pnpm staff:check`, then `npx tsc --noEmit && pnpm lint && pnpm build`, then the four pinned suites.

```bash
git add lib/staff.ts app/api/staff/route.ts scripts/staff-check.mjs
git commit -m "refactor(staff): extract provisioning into lib/staff.ts"
```

---

### Task 3: Branch deactivation reads `staff_profiles`

**Files:**
- Modify: `lib/branch.ts` (delete `isStaff`; rewrite `assignedStaff` and the `staff_count` subquery)
- Modify: `scripts/staff-check.mjs` (section 5)

**Interfaces:**
- Consumes: `staff_profiles` from Task 1.
- Produces: `assignedStaff` and `listBranches().staffCount` sourced from `staff_profiles`.

This changes **shipped code**. `branch:check` must stay at exactly 44 across it.

Why: the `isStaff` predicate is a two-string deny-list, and `dynamicAccessControl` is enabled in `lib/auth.ts`. A custom management role (say `manajer`) is not in `array['owner','admin']`, so it would count as staff — its holder's navigation row would make the branch permanently undeactivatable, naming them as the blocker, with no screen to remove themselves. Reading assignments directly removes the role question entirely.

- [ ] **Step 1: Rewrite `assignedStaff`**

```ts
/**
 * Names of the STAFF assigned to a branch, for the deactivation block.
 *
 * Reads staff_profiles, not team_members: the latter also holds navigational
 * rows for owners and admins, and counting those made every branch
 * undeactivatable. Inactive profiles are excluded -- someone who left must not
 * block closing the branch they used to work at.
 */
export async function assignedStaff(
  teamId: string, organizationId: string,
): Promise<string[]> {
  const { rows } = await db.execute(sql`
    select u.name from staff_profiles s
      join users u on u.id = s.user_id
     where s.team_id = ${teamId} and s.organization_id = ${organizationId}
       and s.active
     order by u.name`)
  return (rows as { name: string }[]).map((r) => r.name)
}
```

- [ ] **Step 2: Rewrite the staff count in `listBranches`**

Replace the `staff_count` subquery with:

```sql
           (select count(*) from staff_profiles s
             where s.team_id = t.id
               and s.organization_id = t.organization_id
               and s.active)::int as staff_count,
```

- [ ] **Step 3: Delete `isStaff`**

Remove the `isStaff` constant and its doc comment from `lib/branch.ts`. Keep the *substance* of the explanation — that management membership is navigational and assignment lives elsewhere — as a short comment on `assignedStaff`, since that is the knowledge the next reader needs.

Run: `grep -rn "isStaff" .` — expected: no matches outside `docs/`.

- [ ] **Step 4: Prove the branch suite still holds**

Run: `pnpm branch:check && pnpm branch:check`
Expected: exactly `44 passed, 0 failed`, twice.

`branch:check` has assertions for "deactivation is refused while staff are assigned", its inverse ("a management-only branch CAN be deactivated"), and "a management-only branch reports staff count 0". Those were written against `isStaff`. If any now fails, **do not weaken the assertion** — the fixtures create staff via raw SQL inserts into `team_members`, so they may need a `staff_profiles` row to match the new source of truth. Fixing the fixture is correct; changing what the assertion claims is not.

- [ ] **Step 5: Assert the custom-role hole is closed**

Append section 5 to `scripts/staff-check.mjs`:

```js
  head('5. assignment does not depend on role strings')
  // The bug this replaces: a custom management role is not in
  // array['owner','admin'], so the old predicate counted its holder as staff
  // and made the branch undeactivatable. Assignment is now a row, not a role.
```

Assertions: give a member the role `manajer`, give them a `team_members` row for a branch but **no** `staff_profiles.team_id`, and assert `assignedStaff` returns an empty list for that branch. Then set their `staff_profiles.team_id` and assert they now appear.

- [ ] **Step 6: Break and restore**

Revert `assignedStaff` to the old `team_members` + `isStaff` query, run `pnpm staff:check`, confirm the section-5 assertion FAILS, restore, confirm it passes. Paste both outputs.

- [ ] **Step 7: Verify and commit**

Run: `pnpm staff:check && pnpm staff:check`, `npx tsc --noEmit && pnpm lint && pnpm build`, and all four pinned suites.

```bash
git add lib/branch.ts scripts/staff-check.mjs
git commit -m "refactor(branch): read assignments from staff_profiles, retire the role filter"
```

---

### Task 4: `/staff` list and `/staff/new`

**Files:**
- Create: `app/(app)/staff/page.tsx`
- Create: `app/(app)/staff/actions.ts`
- Create: `app/(app)/staff/new/page.tsx`
- Create: `app/(app)/staff/new/staff-form.tsx`
- Modify: `scripts/staff-check.mjs` (section 6)

**Interfaces:**
- Consumes: `listStaff`, `provisionStaff` from Task 2; `listBranches` from `lib/branch.ts`.
- Produces: `createStaffAction(prev: FormState, formData: FormData): Promise<FormState>`.

Covers spec §7 assertions 6, 12, 13.

Read `app/(app)/branches/page.tsx` and `app/(app)/branches/new/` first and follow those patterns exactly — `useActionState`, destructive `Alert`, `disabled={pending}`, Indonesian copy.

- [ ] **Step 1: The list page**

`app/(app)/staff/page.tsx` — guarded by `requirePagePermission({ staff: ['read'] })`, then `requirePageOrg()` for the id. Columns: name, email, role, branch (or `—`), status (`Aktif` / `Nonaktif`). A branch filter via a search param. Only owner and admin hold `staff:read`, so there is no partial-visibility case to design.

Show remaining seats in the header — `countResource(organizationId, 'staff')` against the cap — so the constraint is visible before anyone clicks "Tambah staf".

- [ ] **Step 2: The create action**

`app/(app)/staff/actions.ts`:

```ts
'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { PlanError } from '@/lib/plan/entitlements'
import { requirePageOrg, requirePagePermission } from '@/lib/session'
import { provisionStaff } from '@/lib/staff'
import { formError, type FormState } from '@/lib/form-state'
import type { SalonRole } from '@/lib/permissions'

const NEEDS_BRANCH = ['stylist', 'frontdesk']

export async function createStaffAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  await requirePagePermission({ staff: ['create'] })
  const { organizationId } = await requirePageOrg()

  const name = String(formData.get('name') ?? '').trim()
  const email = String(formData.get('email') ?? '').trim()
  const password = String(formData.get('password') ?? '')
  const role = String(formData.get('role') ?? '') as SalonRole
  const teamId = String(formData.get('teamId') ?? '').trim() || null

  if (!name || !email || !password) return { error: 'Nama, email dan kata sandi wajib diisi.' }
  if (password.length < 8) return { error: 'Kata sandi minimal 8 karakter.' }
  // Role decides assignment (spec §4): front desk has branch:read and no
  // switch, so an unassigned one would have nowhere to be; owners and admins
  // are salon-wide.
  if (NEEDS_BRANCH.includes(role) && !teamId) return { error: 'Pilih cabang untuk peran ini.' }
  if (!NEEDS_BRANCH.includes(role) && teamId) return { error: 'Peran ini tidak ditempatkan di cabang.' }

  try {
    await provisionStaff({ organizationId, name, email, password, role, teamId })
  } catch (e) {
    if (e instanceof PlanError) {
      return { error: 'Kuota staf paket Anda sudah tercapai. Upgrade untuk menambah staf.' }
    }
    if (e instanceof Error && e.message === 'EMAIL_TAKEN') {
      return { error: 'Email ini sudah terdaftar.' }
    }
    return { error: formError(e, 'Gagal menambah staf.') }
  }
  revalidatePath('/staff')
  redirect('/staff')
}
```

`formError` returns a **string**, not a `FormState` — wrap it in `{ error: ... }`.

- [ ] **Step 3: The form**

`app/(app)/staff/new/staff-form.tsx` — a client component. The branch select is shown only when the chosen role is `stylist` or `frontdesk`, driven by local state on the role select. Branch options come from `listBranches(organizationId)` passed as a prop from the page.

**Pass only what the form needs** — `{ teamId, name }` per branch, not the full `BranchRow`. Props to client components are serialized into the RSC payload whether or not they are rendered; shipping addresses and phone numbers into a form that only shows names repeats a leak this project has already fixed three times.

- [ ] **Step 4: Assertions**

Append section 6 to `scripts/staff-check.mjs`:

1. A stylist created with a branch has that `team_id` (spec §7.6).
2. An admin created without one has `team_id` null (§7.6).
3. A `frontdesk` user is redirected away from `/staff` — fetch it with their cookie, expect a redirect to `/dashboard`, not a 200 and not a 500 (§7.12).
4. A `stylist` likewise (§7.12).
5. Another salon's staff id reads as not-found: `getStaff(otherSalonUserId, ORG)` returns null, and `/staff/<that id>` does not render their name (§7.13).

- [ ] **Step 5: Break and restore**

Temporarily make `requirePagePermission` return without redirecting. Run `pnpm staff:check`. Confirm the two redirect assertions FAIL. Restore, confirm they pass. Paste both outputs.

- [ ] **Step 6: Verify and commit**

Run the suite twice, `npx tsc --noEmit && pnpm lint && pnpm build`, and the four pinned suites.

```bash
git add "app/(app)/staff" scripts/staff-check.mjs
git commit -m "feat(staff): list and create screens"
```

---

### Task 5: `/staff/[id]` — role change and branch transfer

**Files:**
- Create: `app/(app)/staff/[id]/page.tsx`
- Create: `app/(app)/staff/[id]/staff-detail-forms.tsx`
- Modify: `app/(app)/staff/actions.ts`
- Modify: `scripts/staff-check.mjs` (section 7)

**Interfaces:**
- Consumes: `getStaff`, `assignBranch` from Task 2.
- Produces: `updateStaffRoleAction`, `transferStaffAction` — both `(prev: FormState, formData: FormData) => Promise<FormState>`.

Covers spec §7 assertions 7, 10.

- [ ] **Step 1: The detail page**

Guarded by `requirePagePermission({ staff: ['read'] })`. Loads the member via `getStaff(userId, organizationId)` — org-scoped in the query — and 404s when null. Read `app/(app)/branches/[id]/` first and mirror its layout of separate cards per operation.

- [ ] **Step 2: Role change, with its assignment consequence**

```ts
export async function updateStaffRoleAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  await requirePagePermission({ staff: ['update'] })
  const { organizationId } = await requirePageOrg()
  const userId = String(formData.get('userId') ?? '')
  const role = String(formData.get('role') ?? '') as SalonRole
  const teamId = String(formData.get('teamId') ?? '').trim() || null

  const target = await getStaff(userId, organizationId)
  if (!target) return { error: 'Staf tidak ditemukan.' }
  // An admin must not be able to demote or remove an owner (spec §6.1).
  const actor = await requirePageSession()
  if (target.role.split(',').includes('owner') && !(await isOwner(actor, organizationId))) {
    return { error: 'Hanya pemilik yang dapat mengubah peran pemilik.' }
  }

  if (NEEDS_BRANCH.includes(role) && !teamId) return { error: 'Pilih cabang untuk peran ini.' }

  await auth.api.updateMemberRole({
    body: { memberId: target.userId, organizationId, role },
    headers: await headers(),
  })
  // Assignment follows role (spec §4): promoting to management clears the
  // branch, demoting requires one.
  await assignBranch(userId, organizationId, NEEDS_BRANCH.includes(role) ? teamId : null)

  revalidatePath('/staff')
  revalidatePath(`/staff/${userId}`)
  return { done: true }
}
```

**Verify `auth.api.updateMemberRole`'s exact parameter names against the installed better-auth source before writing this** — whether it takes `memberId` (the `members.id`) or `userId` matters, and this project has been burned by assuming library shapes. State in your report which you confirmed and where.

`isOwner` is a small local helper: does the actor's own `members.role` for this org contain `owner`.

- [ ] **Step 3: Branch transfer**

`transferStaffAction` reads `userId` and `teamId`, then:

- Loads branch status via `getBranchStatus(teamId)` from `lib/plan/branch.ts`.
- **`closed` → 409** — `'Cabang ini nonaktif. Aktifkan dulu sebelum menempatkan staf.'`
- **`over_cap` → 402** — `'Cabang ini terkunci oleh batas paket. Upgrade untuk menempatkan staf.'`
- Checks `closed` **before** `over_cap`, matching `getBranchStatus`'s own ordering: the remedy for a closed branch is reactivation, not an upgrade.
- Otherwise calls `assignBranch(userId, organizationId, teamId)`.

- [ ] **Step 4: Revalidate the right paths**

Both actions call `revalidatePath('/staff')` **and** `revalidatePath('/staff/${userId}')`. Revalidating only the list leaves the detail page showing stale state, so the operator clicks again — a bug this project shipped once already on the branch detail screen.

- [ ] **Step 5: Assertions**

Append section 7:

1. Promoting a stylist to admin sets `team_id` to null (§7.7).
2. Demoting an admin to stylist without a branch is refused (§7.7).
3. Transfer to a **closed** branch returns the 409 copy (§7.10).
4. Transfer to a **locked** (over-cap) branch returns the 402 copy (§7.10).
5. A branch that is both closed and locked yields the **closed** message (§7.10).

Assertion 5 needs a branch that is genuinely both. Build the fixture so the target is over cap *and* inactive, and **assert that precondition in the test** before asserting the message — an assertion whose fixture silently drifts into testing only one condition is how this project shipped a test that passed for the wrong reason.

- [ ] **Step 6: Break and restore**

Swap the `closed`/`over_cap` check order. Confirm assertion 5 fails. Restore. Paste both outputs.

- [ ] **Step 7: Verify and commit**

```bash
git add "app/(app)/staff" scripts/staff-check.mjs
git commit -m "feat(staff): role change and branch transfer"
```

---

### Task 6: Departure — deactivate, reactivate, password reset

**Files:**
- Modify: `app/(app)/staff/actions.ts`
- Modify: `app/(app)/staff/[id]/staff-detail-forms.tsx`
- Modify: `lib/session.ts`
- Modify: `scripts/staff-check.mjs` (section 8)

**Interfaces:**
- Consumes: `getStaff` from Task 2, `requireQuota` from `lib/plan/entitlements.ts`.
- Produces: `deactivateStaffAction`, `reactivateStaffAction`, `resetStaffPasswordAction`.

Covers spec §7 assertions 4, 5, 8, 9, 11.

- [ ] **Step 1: Deactivation, in one statement**

The last owner must not be removable, and the count and the write must not be separate statements. Two admins deactivating the two remaining owners concurrently would both pass a check-then-act guard and leave the salon ownerless.

```ts
  // Locking every active owner row of the salon, then testing the count in the
  // same statement. A concurrent deactivation of a DIFFERENT owner contends on
  // the same lock set, so the second blocks, re-reads, and refuses.
  const { rows: closed } = await db.execute(sql`
    with owners as materialized (
      select s.user_id from staff_profiles s
        join members m on m.user_id = s.user_id
                      and m.organization_id = s.organization_id
       where s.organization_id = ${organizationId} and s.active
         and (string_to_array(m.role, ',') && array['owner'])
       order by s.user_id
         for update of s
    )
    update staff_profiles
       set active = false, deactivated_at = now(), updated_at = now()
     where user_id = ${userId} and organization_id = ${organizationId}
       and active
       and (user_id not in (select user_id from owners)
            or (select count(*) from owners) > 1)
    returning user_id`)
```

Zero rows means one of three things and they are not the same news: already inactive (a double submit — a no-op), the last-owner refusal, or an id from another salon. **Re-read the row to tell them apart rather than trusting the pre-read** — the pre-read is stale in exactly the racing case, which is how a wrong message shipped on the branch screen.

- [ ] **Step 2: Self-deactivation, refused before the SQL**

```ts
  if (userId === actor.user.id) {
    return { error: 'Anda tidak dapat menonaktifkan akun Anda sendiri.' }
  }
```

Without this and the last-owner rule, a one-owner salon can lock itself out of its own tenant with two clicks, with no recovery short of a database edit.

- [ ] **Step 3: Revoke sessions on departure**

```ts
  const ctx = await auth.$context
  await ctx.internalAdapter.deleteUserSessions(userId)
```

Verified present at `node_modules/better-auth/dist/db/internal-adapter.mjs:504`. Note `revokeUserSessions` exists **only in the admin plugin**, which this project deliberately does not use because its roles are global — do not reach for it.

Without this, a dismissed employee keeps working until their cookie expires.

- [ ] **Step 4: Reactivation re-consumes a seat**

`reactivateStaffAction` calls `requireQuota('staff')` **before** flipping `active` back, and maps `PlanError` to the 402 copy: `'Kuota staf paket Anda sudah tercapai. Upgrade untuk mengaktifkan kembali.'` Rehiring into a full plan is a 402, exactly like hiring.

- [ ] **Step 5: Password reset**

`resetStaffPasswordAction` hashes via `ctx.password.hash`, updates the credential account, then calls `deleteUserSessions(userId)`. A reset that leaves existing sessions alive does not lock out whoever prompted it.

Verify how to update the stored password against the installed better-auth source — `internalAdapter.updatePassword` or the account update path — and name what you confirmed in your report.

- [ ] **Step 6: Refuse deactivated logins**

In `lib/session.ts`, after the session resolves, both guard families check the profile and fail in their own idiom — `requirePageSession` redirects to sign-in, `requireUser` throws:

```ts
  // A deactivated staff member must not keep working on a live cookie. Checked
  // here because it is the one place both guard families converge.
  const { rows } = await db.execute(sql`
    select active from staff_profiles
     where user_id = ${session.user.id}
       and organization_id = ${session.session.activeOrganizationId}`)
  if (rows[0] && (rows[0] as { active: boolean }).active === false) { /* refuse */ }
```

- [ ] **Step 7: Assertions**

Append section 8:

1. Deactivating a stylist frees a seat — proven by **successfully hiring into the freed seat at a cap that was full**, not by re-reading a count the test computed (§7.4).
2. Reactivating at the cap returns 402 (§7.5).
3. The last owner cannot be deactivated (§7.8).
4. The same, **from two concurrent connections** against the live database — one succeeds, one refuses, at least one owner remains (§7.8).
5. An owner cannot deactivate themselves (§7.9).
6. Deactivation revokes sessions: the old cookie no longer authenticates (§7.11).
7. Password reset revokes sessions: same check (§7.11).
8. Every `staff_profiles` row with a `team_id` has a matching `team_members` row (§7.14).

Assertion 1 is the subtle one. "Frees a seat" means creation that was refused now succeeds — a count query alone tests a SELECT, not the product decision.

If this section mutates the shared `plan_limits` staff cap, **restore it to the seeded value at the end of the section**.

- [ ] **Step 8: Break and restore, three times**

Break the last-owner clause → assertion 3 fails. Break `deleteUserSessions` → assertions 6 and 7 fail. Break the `requireQuota` in reactivation → assertion 2 fails. Restore each, confirm green. Paste all outputs.

- [ ] **Step 9: Verify and commit**

```bash
git add "app/(app)/staff" lib/session.ts scripts/staff-check.mjs
git commit -m "feat(staff): departure, rehire and password reset"
```

---

### Task 7: `/staff/import` — bulk creation

**Files:**
- Create: `app/(app)/staff/import/page.tsx`
- Create: `app/(app)/staff/import/import-form.tsx`
- Modify: `app/(app)/staff/actions.ts`
- Modify: `scripts/staff-check.mjs` (section 9)

**Interfaces:**
- Consumes: `provisionStaff` from Task 2, `countResource` / `resolveEntitlements` from `lib/plan/entitlements.ts`.
- Produces: `importStaffAction(prev: ImportState, formData: FormData): Promise<ImportState>` where `ImportState = { error?: string; rows?: { line: number; message: string }[]; created?: number }`.

Covers spec §7 assertions 15, 16, 17.

**Sequenced last deliberately.** Nothing else depends on it, so it can be dropped under schedule pressure without disturbing the rest of the feature.

- [ ] **Step 1: Show the seat budget before a file is chosen**

The page renders `Sisa kuota staf: <remaining> dari <cap>` from `countResource` and the resolved cap, so the constraint is visible while deciding what to paste.

- [ ] **Step 2: Parse and validate everything, commit nothing yet**

Columns: `name, email, password, role, branch name`. Validate every row and collect **all** failures before creating anything:

- missing name, email or password
- password shorter than 8 (`minPasswordLength` is 8, `lib/auth.ts:41`)
- unknown role
- branch name that does not resolve to a branch in this salon
- a branch named for an `owner`/`admin` row, or missing for a `stylist`/`frontdesk` row (spec §4)
- an email duplicated within the file
- an email already taken

- [ ] **Step 3: Check the seat budget once, for the whole file**

```ts
  if (validRows.length > remaining) {
    return { error: `Butuh ${validRows.length} kursi staf, tersisa ${remaining}. Upgrade paket untuk melanjutkan.` }
  }
```

One 402-shaped refusal naming the shortfall — never a partial import.

- [ ] **Step 4: Commit all rows, or none**

Only once validation and the budget check both pass, create every row. If any row still fails at creation, report it plainly with how many were created — but the validation pass should have made that unreachable.

There is **no preview-and-confirm step**: in the happy path it only ever says yes, and the failure path already reports everything with nothing written.

- [ ] **Step 5: Assertions**

Append section 9:

1. A file with one bad row creates **nothing** — assert the count of members is unchanged, not merely that an error was returned (§7.15).
2. A file needing more seats than remain returns one error naming the shortfall, and creates nothing (§7.16).
3. A clean file creates every row, each with the right role and branch (§7.17).
4. A management row naming a branch is a validation error (spec §5.4).

Assertion 1 is the load-bearing one: "returns an error" is satisfied by code that creates 12 of 20 rows and then fails. Assert the row count.

- [ ] **Step 6: Break and restore**

Move the seat check to after creation. Confirm assertion 2 fails (rows were created). Restore. Paste both outputs.

- [ ] **Step 7: Verify and commit**

Run the suite twice, `npx tsc --noEmit && pnpm lint && pnpm build`, and all four pinned suites.

```bash
git add "app/(app)/staff" scripts/staff-check.mjs
git commit -m "feat(staff): bulk import"
```
