/**
 * Reading a Postgres error through Drizzle.
 *
 * Drizzle wraps a driver error in a DrizzleQueryError and puts the original on
 * `cause`, so `e.code` at the top level is ALWAYS undefined. This has already
 * cost this project one dead code path: booking's "any available" retry
 * matched 23P01 on the top level and therefore never fired, which no test
 * caught until the race was made deterministic.
 *
 * Lives here so the next caller finds it instead of re-deriving it.
 */
const walk = <T>(e: unknown, read: (o: Record<string, unknown>) => T | undefined): T | undefined => {
  let cur: unknown = e
  for (let depth = 0; depth < 5 && typeof cur === 'object' && cur !== null; depth++) {
    const got = read(cur as Record<string, unknown>)
    if (got !== undefined) return got
    cur = (cur as { cause?: unknown }).cause
  }
  return undefined
}

/** The SQLSTATE, e.g. '23P01' (exclusion_violation), '23505' (unique). */
export const pgCode = (e: unknown): string | undefined =>
  walk(e, (o) => (typeof o.code === 'string' ? o.code : undefined))

/** Whether any message in the chain names this constraint, index or phrase. */
export const pgMentions = (e: unknown, needle: string): boolean =>
  walk(e, (o) => {
    const parts = [o.constraint, o.message, o.detail].filter((v) => typeof v === 'string')
    return parts.some((v) => (v as string).includes(needle)) ? true : undefined
  }) ?? false
