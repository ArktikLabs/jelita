type Params = Record<string, string | string[] | undefined>

/**
 * Build the href for a list control.
 *
 * Every control uses this rather than composing its own query string, because
 * two rules have to hold everywhere and both are easy to forget:
 *
 *   1. Preserve the parameters you were not asked to change. A search box that
 *      drops the active filter is the classic URL-state bug.
 *   2. Reset the page whenever the RESULT SET changes -- a new sort, search or
 *      filter. Staying on page 7 of a result that now has two pages shows an
 *      empty table that reads as a broken app.
 */
export function listHref(
  current: Params,
  changes: Record<string, string | null>,
): string {
  const next = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) {
    const value = Array.isArray(v) ? v[0] : v
    if (value !== undefined && value !== '') next.set(k, value)
  }
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) next.delete(k)
    else next.set(k, v)
  }
  // Rule 2: anything but a page move invalidates the current page number.
  if (!('page' in changes)) next.delete('page')
  return `?${next.toString()}`
}
