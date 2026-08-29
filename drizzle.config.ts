import { existsSync } from 'node:fs'
import type { Config } from 'drizzle-kit'

if (existsSync('.env.local')) process.loadEnvFile('.env.local')

export default {
  schema: './lib/schema/index.ts',
  out: './db/migrations',
  dialect: 'postgresql',
  // session pooler: drizzle-kit runs DDL, which transaction mode handles badly
  dbCredentials: { url: process.env.DIRECT_URL! },
} satisfies Config
