import { exportQuery, type ListQuery, type ListResult, type ListSpec } from './list-query'

export type BulkOutcome = { done: number; refused: number; total: number }

/**
 * §7's two modes, resolved server-side.
 *
 * "All matching" posts the FILTER, not the ids: four thousand ids in a form
 * body is a request nobody should send, and one the browser may silently
 * truncate. The filter is re-run here against the same list function the
 * screen used, so what gets acted on is by construction what was shown.
 *
 * Capped at EXPORT_CAP for the same reason the export is: a bulk action over
 * more rows than that is not this product's case, and an uncapped one is an
 * unbounded statement.
 */
export async function resolveSelection<K extends string, T>(opts: {
  spec: ListSpec<K>
  params: Record<string, string | string[] | undefined>
  ids: string[]
  allMatching: boolean
  list: (q: ListQuery) => Promise<ListResult<T>>
  /** How to read the id off a row. REQUIRED, because the six row types do
   *  not agree on a name: CustomerRow/ServiceRow have `id`, StaffRow has
   *  `userId`, BranchRow has `teamId`. */
  idOf: (row: T) => string
}): Promise<string[]> {
  if (!opts.allMatching) return opts.ids
  const { rows } = await opts.list(exportQuery(opts.spec, opts.params))
  return rows.map(opts.idOf)
}

/**
 * Runs the per-row action, counting what actually happened.
 *
 * Each deactivate* returns false when the row was refused -- the last-owner
 * guard, a branch with staff still stationed there. Reporting those as done
 * is the dishonesty 2b8fe2f fixed for role updates: the person is told two
 * hundred rows went when one is still live, and they have no way to find
 * which.
 *
 * Sequential, not `Promise.all`: `deactivateStaff` takes `FOR UPDATE` locks
 * on an owners CTE, and concurrent calls deadlock against each other.
 */
export async function bulkDeactivate(
  ids: string[], run: (id: string) => Promise<boolean>,
): Promise<BulkOutcome> {
  let done = 0
  for (const id of ids) if (await run(id)) done++
  return { done, refused: ids.length - done, total: ids.length }
}

/**
 * §7's confirmation copy, in Indonesian. `refusedReason` says what "ditolak"
 * means for THIS resource -- unused (and unwritten) whenever nothing was
 * refused, because a reason for zero refusals is a sentence about nothing.
 */
export function bulkMessage(outcome: BulkOutcome, refusedReason: string): string {
  if (outcome.refused === 0) return `${outcome.done} dinonaktifkan.`
  return `${outcome.done} dinonaktifkan, ${outcome.refused} ditolak (${refusedReason}).`
}

/**
 * The other half of SelectionBar's form: `ids`/`allMatching` pulled back
 * apart from the rest of the posted filter, which is everything a resource's
 * ListSpec might read off `params` (Task 1's `exportQuery`/`parseListQuery`
 * ignore whatever key they don't recognise, so passing the lot through here
 * is safe for every resource).
 */
export function selectionFromForm(formData: FormData): {
  ids: string[]
  allMatching: boolean
  params: Record<string, string | string[] | undefined>
} {
  const ids = formData.getAll('ids').map(String)
  const allMatching = formData.get('allMatching') === '1'
  const params: Record<string, string | string[] | undefined> = {}
  for (const [key, value] of formData.entries()) {
    if (key === 'ids' || key === 'allMatching') continue
    params[key] = String(value)
  }
  return { ids, allMatching, params }
}
