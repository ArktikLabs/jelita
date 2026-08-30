import { appendFileSync } from 'node:fs'

/**
 * ponytail: file + console transport. Swap for the §5.5 notification adapter
 * when it lands — same signature, so this becomes a one-line delegation.
 *
 * Writing to .mail.log (gitignored) makes password-reset and invitation links
 * greppable in dev instead of requiring a real inbox.
 */
export async function sendMail(to: string, subject: string, body: string) {
  const entry = `\n[${new Date().toISOString()}] to=${to} subject="${subject}"\n${body}\n`
  console.log(entry)
  try {
    appendFileSync('.mail.log', entry)
  } catch {
    // best effort: read-only fs in prod is fine, console still has it
  }
}
