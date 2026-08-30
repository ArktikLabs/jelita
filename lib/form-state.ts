import { APIError } from 'better-auth/api'

export type FormState = { error?: string; done?: boolean }

/**
 * The message better-auth put on an APIError, or `fallback` for anything
 * else. Client components import `FormState` with `import type`, so this
 * runtime import never reaches the browser bundle.
 */
export const formError = (e: unknown, fallback: string) =>
  e instanceof APIError ? (e.body?.message as string) ?? fallback : fallback
