import { appendFileSync } from 'node:fs'

export type Channel = 'email' | 'whatsapp' | 'telegram'
export type Message = {
  channel: Channel
  to: string
  subject?: string
  body: string
}
type Transport = (m: Message) => Promise<void>

/**
 * Writes to .mail.log (gitignored) so password-reset, verification and
 * invitation links are greppable in dev instead of needing a real inbox.
 * scripts/ui-check.mjs reads this file to drive the end-to-end flows.
 */
const logTransport: Transport = async (m) => {
  const entry =
    `\n[${new Date().toISOString()}] channel=${m.channel} to=${m.to}`
    + `${m.subject ? ` subject="${m.subject}"` : ''}\n${m.body}\n`
  console.log(entry)
  try {
    appendFileSync('.mail.log', entry)
  } catch {
    // best effort: a read-only fs in prod is fine, console still has it
  }
}

// One transport today. Wiring a real channel is: write the transport, swap the
// entry below. Nothing above this line changes. Deliberately no registry and no
// env branching — nothing registers anything, and a key check guarding a
// transport that does not exist is a branch guarding nothing.
const transports: Record<Channel, Transport> = {
  email: logTransport,
  whatsapp: logTransport,
  telegram: logTransport,
}

export const notify = (m: Message) => transports[m.channel](m)
