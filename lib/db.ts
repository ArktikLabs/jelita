import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from './schema'
import { pool } from './pg-pool'

export const db = drizzle(pool, { schema })
