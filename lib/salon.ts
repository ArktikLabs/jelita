import { sql } from 'drizzle-orm'
import { db } from './db'
import { listBranches } from './branch'
import type { CurrencyCode } from './money'

/**
 * Resolving a salon from the outside world.
 *
 * The subdomain says which salon to LOOK UP. It proves nothing -- every public
 * page and action calls these, rather than trusting a hostname or a form field
 * that reached them (spec 2.2).
 */

export type PublicSalon = {
  organizationId: string
  name: string
  currency: CurrencyCode
  slotMinutes: number
}

/** Only what a stranger may see. Deliberately NOT a BranchRow: staffCount and
 *  withinCap are the salon's business, and props to a client component are
 *  serialized into the RSC payload whether they are rendered or not -- the bug
 *  already fixed once in the app shell's branch switcher. */
export type PublicBranch = {
  teamId: string
  name: string
  address: string | null
  /**
   * Phone and hours are on here because a shopfront prints them on its own
   * door. The rule this widened under, so the next addition has to argue
   * against it: a field belongs on PublicBranch only if a salon would put it
   * on their own signage. staffCount and withinCap still do not.
   */
  phone: string | null
  hours: { weekday: number; closed: boolean; opensAt: string; closesAt: string }[]
}

/**
 * The salon a subdomain names, or null.
 *
 * Null covers "no such slug" and any future "not accepting bookings" reason
 * alike: a public page must not let a stranger tell the difference, or the
 * 404 becomes a directory of which salons exist.
 */
export async function resolveSalon(slug: string): Promise<PublicSalon | null> {
  if (!slug) return null
  const { rows } = await db.execute(sql`
    select o.id, o.name, p.currency, p.slot_minutes
      from organizations o
      join salon_profiles p on p.organization_id = o.id
     where o.slug = ${slug}`)
  const r = rows[0] as Record<string, unknown> | undefined
  if (!r) return null
  return {
    organizationId: r.id as string,
    name: r.name as string,
    currency: r.currency as CurrencyCode,
    slotMinutes: Number(r.slot_minutes),
  }
}

/**
 * The branches a stranger may book into: ACTIVE and WITHIN CAP.
 *
 * Both halves matter, for different reasons. Inactive is the salon's own
 * choice. Within-cap is not: a salon that downgrades from Pro to Free keeps
 * three branches against a cap of one, and the two over the line are
 * read-only. Offering those would take bookings for a branch the salon cannot
 * operate -- worse than not showing it at all (spec 2.5).
 *
 * Built on listBranches rather than a second query, so the cap rule has one
 * definition; the narrowing to PublicBranch is what keeps the rest off the
 * wire.
 *
 * `active` is REDUNDANT today and kept anyway: branch_entitlement ranks only
 * active branches (0008_branch_tables.sql), so a closed one has no row and
 * listBranches coalesces its within_cap to false. That coupling is invisible
 * from here, and it is the view's to change -- this filter stays correct on
 * its own terms either way. It therefore has no break evidence and cannot:
 * "closed but within cap" is unrepresentable. The view's guarantee is asserted
 * directly in tests/salon.db.test.ts instead, where it CAN fail.
 */
export async function bookableBranches(organizationId: string): Promise<PublicBranch[]> {
  const branches = await listBranches(organizationId)
  const open = branches.filter((b) => b.active && b.withinCap)
  if (open.length === 0) return []

  // ONE query for every branch's week, not getBranch() per branch: the landing
  // page renders them all, and a salon on the business tier has no ceiling on
  // how many that is.
  const ids = open.map((b) => b.teamId)
  const { rows } = await db.execute(sql`
    select team_id, weekday, closed, opens_at, closes_at from branch_hours
     where team_id in ${sql`(${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`}
     order by team_id, weekday`)

  const byTeam = new Map<string, PublicBranch['hours']>()
  for (const r of rows as Record<string, unknown>[]) {
    const teamId = r.team_id as string
    const list = byTeam.get(teamId) ?? []
    list.push({
      weekday: Number(r.weekday),
      closed: r.closed as boolean,
      opensAt: String(r.opens_at).slice(0, 5),
      closesAt: String(r.closes_at).slice(0, 5),
    })
    byTeam.set(teamId, list)
  }

  return open.map((b) => ({
    teamId: b.teamId,
    name: b.name,
    address: b.address,
    phone: b.phone,
    hours: byTeam.get(b.teamId) ?? [],
  }))
}

/**
 * The branch a customer chose, checked AGAINST THIS SALON, or null.
 *
 * This is the tenant boundary. Without it,
 * `ovarya.atjelita.com/book?cabang=<another salon's branch>` would reach
 * available_slots with a foreign team id. The composite foreign keys make the
 * booking itself unrepresentable (engine spec 3.4), so the failure would be a
 * constraint error rather than corruption -- this turns it into a not-found.
 *
 * With exactly one bookable branch the choice is implicit: a single-branch
 * salon (free and starter tiers) never shows the step at all.
 */
export async function resolveBranch(
  organizationId: string, teamId?: string | null,
): Promise<PublicBranch | null> {
  const branches = await bookableBranches(organizationId)
  if (!teamId) return branches.length === 1 ? branches[0] : null
  return branches.find((b) => b.teamId === teamId) ?? null
}

/**
 * How many live bookings this number already holds at this salon today.
 *
 * The cap that uses it lives in the PUBLIC action alone, never in
 * createBooking: the front desk routes through the same function and must
 * never be capped -- a busy Saturday is not abuse.
 *
 * Counted by phone_key, the normalised form (lib/phone.ts), so re-spelling the
 * same number as +62 / 62 / 0 does not buy a fresh allowance. Cancelled and
 * no-show rows are excluded: a customer who cancelled and rebooked twice is a
 * customer, not a script.
 */
export async function bookingsTodayFor(
  organizationId: string, phoneKey: string, date: string,
): Promise<number> {
  const { rows } = await db.execute(sql`
    select count(*)::int as n
      from bookings b
      join customers c on c.id = b.customer_id
     where b.organization_id = ${organizationId}
       and c.phone_key = ${phoneKey}
       and b.starts_at >= ${date}::date and b.starts_at < ${date}::date + 1
       and b.status in ('pending', 'confirmed')`)
  return Number((rows[0] as { n: number }).n)
}
