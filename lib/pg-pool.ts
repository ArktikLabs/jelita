import { Pool } from 'pg'

// Next dev reloads this module on every edit; without the global the pool leaks
// connections until Supabase refuses new ones.
//
// Deliberately self-contained: no `./schema` import and no non-erasable
// TypeScript syntax (no parameter properties, no enums), so this file also
// imports cleanly under plain Node's type-stripping (used by
// scripts/plan-check.mjs to dynamically import lib/plan/branch.ts).
const g = globalThis as unknown as { _pool?: Pool }

export const pool = (g._pool ??= new Pool({ connectionString: process.env.DATABASE_URL }))
