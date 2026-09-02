import { APIError } from 'better-auth/api'

export type FormState = { error?: string; done?: boolean }

/** Bulk staff import (app/dashboard/(shell)/staff/import). One entry in `rows` per bad
 *  line -- the whole point of the all-or-nothing design is that this is the
 *  only place a partial result is even representable, and it should only
 *  ever be reached by the unreachable-in-practice failure branch. */
export type ImportState = {
  error?: string
  rows?: { line: number; message: string }[]
  created?: number
}

/**
 * The message better-auth put on an APIError, or `fallback` for anything
 * else. Client components import `FormState` with `import type`, so this
 * runtime import never reaches the browser bundle.
 */
export const formError = (e: unknown, fallback: string) =>
  e instanceof APIError ? (e.body?.message as string) ?? fallback : fallback
