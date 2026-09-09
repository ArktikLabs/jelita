/**
 * A quiet "who/when" line for a detail page's audit columns (spec §5's
 * "who changed this"). Columns nobody can see are plumbing, not an audit
 * trail -- this is the one place all four (customers, services, staff,
 * branches) render them, so the wording stays identical across pages.
 *
 * `created.by` null means the actor is genuinely unknown (a public booking,
 * the seed script, a cron -- the column cannot tell those apart) -- the
 * segment is left out entirely rather than printed as "Dibuat oleh —",
 * which would read as a missing name rather than an absent person. No
 * per-caller fallback text: an earlier version let customers guess "Dibuat
 * dari halaman booking" for any null actor, but a seeded customer is also
 * null there, so that guess was sometimes false. Omission is the only
 * honest option the data supports.
 *
 * `updated` and `deactivated` are each single lines the CALLER decides to
 * pass or withhold:
 *  - `updated` is omitted by the caller when updated_by is null, or when
 *    it is the same actor who created the row seconds ago (provisionStaff
 *    inserting a row and assignBranch updating it right after is real, but
 *    a second line for it would read as noise).
 *  - `deactivated` is passed only while the row is currently inactive --
 *    that is the one event people actually come here to ask about.
 */
export function AuditTrail({
  created, updated, deactivated,
}: {
  created: { by: string | null; at: string }
  updated?: { by: string; at: string } | null
  deactivated?: { by: string; at: string } | null
}) {
  const parts: string[] = []
  if (created.by) parts.push(`Dibuat oleh ${created.by} · ${created.at}`)
  if (updated) parts.push(`Diubah oleh ${updated.by} · ${updated.at}`)
  if (deactivated) parts.push(`Dinonaktifkan oleh ${deactivated.by} · ${deactivated.at}`)

  if (parts.length === 0) return null
  return <p className="text-xs text-muted-foreground">{parts.join(' · ')}</p>
}
