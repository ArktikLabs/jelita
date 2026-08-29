import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from './schema'

// Next dev reloads this module on every edit; without the global the pool leaks
// connections until Supabase refuses new ones.
const g = globalThis as unknown as { _pool?: Pool }
const pool = (g._pool ??= new Pool({ connectionString: process.env.DATABASE_URL }))

export const db = drizzle(pool, { schema })
