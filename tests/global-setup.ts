import { resetDatabase } from './reset-db'

/** Every Vitest run starts from a freshly built schema. See tests/reset-db.ts. */
export default async function setup() {
  await resetDatabase()
}
