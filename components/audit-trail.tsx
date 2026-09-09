/**
 * A quiet "who/when" line for a detail page's audit columns (spec §5's
 * "who changed this"). Columns nobody can see are plumbing, not an audit
 * trail -- this is the one place all four (customers, services, staff,
 * branches) render them, so the wording stays identical across pages.
 *
 * `created.by` null with no `fallback` means the actor is genuinely unknown
 * (seed data, a cron) -- the segment is left out entirely rather than
 * printed as "Dibuat oleh —", which would read as a missing name rather
 * than an absent person.
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
  created: { by: string | null; fallback?: string; at: string }
  updated?: { by: string; at: string } | null
  deactivated?: { by: string; at: string } | null
}) {
  const parts: string[] = []
  if (created.by) parts.push(`Dibuat oleh ${created.by} · ${created.at}`)
  else if (created.fallback) parts.push(`${created.fallback} · ${created.at}`)
  if (updated) parts.push(`Diubah oleh ${updated.by} · ${updated.at}`)
  if (deactivated) parts.push(`Dinonaktifkan oleh ${deactivated.by} · ${deactivated.at}`)

  if (parts.length === 0) return null
  return <p className="text-xs text-muted-foreground">{parts.join(' · ')}</p>
}
