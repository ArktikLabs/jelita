import { pool } from '../pg-pool.ts'

/**
 * Is this branch within its tenant's cap? Computed, never stored.
 *
 * Deliberately self-contained: no `../session` import, no classes (so
 * nothing here is non-erasable TypeScript). Issues one parameterised query
 * directly against the shared pool — no drizzle needed for a single select.
 * This keeps the file importable by plain Node's type-stripping, which
 * scripts/plan-check.mjs relies on to dynamically import it.
 */
export async function isBranchActive(teamId: string): Promise<boolean> {
  const { rows } = await pool.query(
    'select is_active from branch_entitlement where team_id = $1 limit 1', [teamId])
  const row = rows[0] as { is_active: boolean } | undefined
  return row?.is_active ?? true // unknown branch: let other layers 404 it
}
