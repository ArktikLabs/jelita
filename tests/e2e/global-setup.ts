import { resetDatabase } from '../reset-db'

/** Every Playwright run starts from a freshly built schema. See tests/reset-db.ts. */
export default async function globalSetup() {
  await resetDatabase()
}
