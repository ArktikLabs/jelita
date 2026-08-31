import { pool } from '../pg-pool.ts'

export type BranchStatus = 'ok' | 'over_cap' | 'closed'

/**
 * Why a branch is or isn't writable. Two different read-only reasons that must
 * not share an error: over_cap is a tier problem whose remedy is "upgrade";
 * closed is a decision the owner made, whose remedy is "reactivate".
 *
 * organizationId is REQUIRED and joined in the same statement, never checked
 * by the caller afterwards: teamId reaches here straight from a form or a JSON
 * body, and an unscoped read told the caller whether ANOTHER salon's branch
 * existed and whether it was closed or locked (spec §6.3 -- another salon's
 * branch "reads as not-found, never as a leak of that branch's existence").
 * Scoping the read itself means every caller inherits that, instead of each
 * one remembering a pre-check.
 *
 * Deliberately self-contained: no `../session` import, no classes (so nothing
 * here is non-erasable TypeScript). Keeps the file importable by plain Node's
 * type-stripping, which the check suites rely on.
 */
export async function getBranchStatus(
  teamId: string, organizationId: string,
): Promise<BranchStatus> {
  const { rows } = await pool.query(
    `select p.active, e.within_cap
       from branch_profiles p
       join teams t on t.id = p.team_id
       left join branch_entitlement e on e.team_id = p.team_id
      where p.team_id = $1 and t.organization_id = $2
      limit 1`,
    [teamId, organizationId],
  )
  const row = rows[0] as { active: boolean; within_cap: boolean | null } | undefined
  // Unknown branch, or one belonging to another salon -- indistinguishable on
  // purpose. Let other layers 404 it.
  if (!row) return 'ok'
  if (!row.active) return 'closed'
  return row.within_cap === false ? 'over_cap' : 'ok'
}
