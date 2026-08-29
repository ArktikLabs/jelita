import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'

/**
 * Is this branch within its tenant's cap? Computed, never stored.
 *
 * Deliberately self-contained: no `../session` import, no classes (so
 * nothing here is non-erasable TypeScript), and — importantly — no `../db`
 * import either. `lib/db.ts` transitively imports the `lib/schema`
 * directory via extensionless relative specifiers, which plain Node's
 * ESM resolver refuses outright ("Directory import ... is not supported
 * resolving ES modules"); that's a structural fact of this repo, not
 * something a class removal fixes. Raw SQL via drizzle's `sql` tag needs
 * no schema, so this file builds its own minimal client instead.
 *
 * Reuses `lib/db.ts`'s pool-caching convention (`globalThis._pool`) so the
 * running app shares one Postgres pool instead of opening a second one;
 * scripts/plan-check.mjs (a short-lived process) gets its own, same as the
 * `pg.Pool` it already opens directly.
 */
const g = globalThis as unknown as { _pool?: Pool }
const pool = (g._pool ??= new Pool({ connectionString: process.env.DATABASE_URL }))
const db = drizzle(pool)

export async function isBranchActive(teamId: string): Promise<boolean> {
  const { rows } = await db.execute(sql`
    select is_active from branch_entitlement where team_id = ${teamId} limit 1`)
  const row = rows[0] as { is_active: boolean } | undefined
  return row?.is_active ?? true // unknown branch: let other layers 404 it
}
