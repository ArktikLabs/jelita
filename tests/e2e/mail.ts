import { readFileSync, writeFileSync } from 'node:fs'

/** The dev transport appends to .mail.log (lib/notify.ts). */
export const clearMail = () => writeFileSync('.mail.log', '')

/**
 * Poll for a pattern rather than sleeping.
 *
 * The suite this replaces waited a flat 500ms after each send. A fixed sleep
 * is a guess at how long a round trip takes: too short and the assertion fails
 * for no reason, too long and every run pays for the worst case. Polling
 * returns the moment the line lands and fails loudly if it never does.
 */
export async function waitForMail(pattern: RegExp, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const match = readFileSync('.mail.log', 'utf8').match(pattern)
    if (match) return match[1]
    if (Date.now() > deadline) {
      throw new Error(`no mail matching ${pattern} within ${timeoutMs}ms`)
    }
    await new Promise((r) => setTimeout(r, 50))
  }
}
