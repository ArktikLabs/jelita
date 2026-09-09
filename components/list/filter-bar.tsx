import Link from 'next/link'
import { listHref, preservedFields, type Params } from '@/lib/list-url'
import { buttonVariants } from '@/components/ui/button'
import type { ListQuery, ListSpec } from '@/lib/list-query'

/**
 * Indonesian label for one value of an enum-shaped filter. `active` is the
 * only one any of the six specs declares today (customers, products,
 * services, branches, staff); an enum filter with no entry here just shows
 * its raw value, which keeps this from being a wall no future filter can
 * pass without an edit here too.
 */
const ENUM_LABELS: Record<string, Record<string, string>> = {
  active: { true: 'Aktif', false: 'Nonaktif' },
}

/**
 * How to render one validator-backed (function-form) filter.
 *
 * A `FilterRule` function only promises the value is legal by SHAPE -- it
 * says nothing about what widget shows it, or (for a lookup like `branch`)
 * what its options are labelled, because that's DB data the spec cannot see.
 * One entry per such filter the page declares.
 */
export type FilterControl =
  | { type: 'date'; label: string; value?: string }
  | { type: 'select'; options: { value: string; label: string }[]; placeholder: string }

/**
 * One control per filter the spec declares -- generalised from customers'
 * lone `active` filter and pos's `date` now that four more specs and staff's
 * folded-in `branch` exist to generalise from (Task 5).
 *
 * Two shapes, matching `FilterRule`:
 *
 *   - array (enum): a segmented set of links, "Semua" plus one per legal
 *     value. Every href routes through `listHref`, never a hand-built query
 *     string, so clicking one preserves the sort and search and resets the
 *     page for free -- the bug class `listHref`'s own docstring warns about.
 *
 *   - function (validator-backed): a native GET form, because a GET submit
 *     replaces the WHOLE query string with only its own named inputs and so
 *     cannot route through `listHref` like the links above. `preservedFields`
 *     is what stops it from silently dropping the sort, the search, or a
 *     sibling filter not owned by this form.
 *
 * Nothing here ever writes a filter's RESOLVED value back into a link or a
 * hidden field -- only what the visitor actually chose (`query.filters`, sourced
 * from the URL). A page that fills in its own default for the query (pos's
 * `date` defaulting to today) may still show that default as the form
 * input's pre-filled VALUE via `controls.value` -- that's display only and
 * never touches `params`, so a filter at its default still never appears in
 * the URL.
 */
export function FilterBar<K extends string>({
  spec, query, params, controls,
}: {
  spec: ListSpec<K>
  query: ListQuery
  params: Params
  /** One entry per validator-backed filter the spec declares. */
  controls?: Record<string, FilterControl>
}) {
  const entries = Object.entries(spec.filters ?? {})
  if (entries.length === 0) return null

  const enumFilters = entries.filter(
    (e): e is [string, readonly string[]] => Array.isArray(e[1]),
  )
  const formFilters = entries
    .filter((e) => typeof e[1] === 'function')
    .map(([name]) => name)
  // Only a WIRED filter is this form's to own: preservedFields' `own` list
  // means "this form renders an input for it", and an unwired one renders
  // none (see the `!control` branch below) -- excluding it from
  // preservedFields too would drop it from the URL on every submit with
  // nothing to carry it forward, the exact silently-dropped-parameter bug
  // this component exists to prevent, just inverted.
  const wiredFormFilters = formFilters.filter((name) => controls?.[name] !== undefined)

  return (
    <div className="flex flex-wrap items-end gap-4">
      {enumFilters.map(([name, values]) => {
        const current = query.filters[name]
        return (
          <div key={name} role="group" className="flex items-center gap-1.5">
            <Link
              href={listHref(params, { [name]: null })}
              className={buttonVariants({
                variant: current === undefined ? 'default' : 'outline', size: 'sm',
              })}
            >
              Semua
            </Link>
            {values.map((v) => (
              <Link
                key={v}
                href={listHref(params, { [name]: v })}
                className={buttonVariants({ variant: current === v ? 'default' : 'outline', size: 'sm' })}
              >
                {ENUM_LABELS[name]?.[v] ?? v}
              </Link>
            ))}
          </div>
        )
      })}

      {formFilters.length > 0 && (
        <form className="flex items-end gap-2">
          {preservedFields(params, wiredFormFilters).map(([n, v]) => (
            <input key={n} type="hidden" name={n} value={v} />
          ))}
          {formFilters.map((name) => {
            const control = controls?.[name]
            // A function-form filter with no control wired by the page has
            // nothing to render -- rather than guess a widget for a shape it
            // knows nothing about. It's still carried forward as a hidden
            // field via wiredFormFilters above (it's simply not in that
            // list), same as any other parameter this form doesn't own.
            if (!control) return null

            if (control.type === 'date') {
              const value = control.value ?? query.filters[name] ?? ''
              return (
                <div key={name} className="space-y-2">
                  <label htmlFor={name} className="text-sm font-medium">{control.label}</label>
                  <input
                    id={name} type="date" name={name} defaultValue={value}
                    className="flex h-9 rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs"
                  />
                </div>
              )
            }

            const value = query.filters[name] ?? ''
            return (
              <select
                key={name} name={name} defaultValue={value}
                className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
              >
                <option value="">{control.placeholder}</option>
                {control.options.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            )
          })}
          <button type="submit" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Filter
          </button>
        </form>
      )}
    </div>
  )
}
