import { pool } from '../pg-pool.ts'

export type BranchStatus = 'ok' | 'over_cap' | 'closed'

/**
 * Why a branch is or isn't writable. Two different read-only reasons that must
 * not share an error: over_cap is a tier problem whose remedy is "upgrade";
 * closed is a decision the owner made, whose remedy is "reactivate".
 *
 * Deliberately self-contained: no `../session` import, no classes (so nothing
 * here is non-erasable TypeScript). Keeps the file importable by plain Node's
 * type-stripping, which the check suites rely on.
 */
export async function getBranchStatus(teamId: string): Promise<BranchStatus> {
  const { rows } = await pool.query(
    `select p.active, e.within_cap
       from branch_profiles p
       left join branch_entitlement e on e.team_id = p.team_id
      where p.team_id = $1
      limit 1`,
    [teamId],
  )
  const row = rows[0] as { active: boolean; within_cap: boolean | null } | undefined
  if (!row) return 'ok'          // unknown branch: let other layers 404 it
  if (!row.active) return 'closed'
  return row.within_cap === false ? 'over_cap' : 'ok'
}
