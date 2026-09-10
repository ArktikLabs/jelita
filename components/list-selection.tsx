'use client'

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { useSearchParams } from 'next/navigation'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Button, buttonVariants } from '@/components/ui/button'
import { preservedFields } from '@/lib/list-url'

/**
 * Spec §7's two selection modes: a `Set` of ids for "the 25 on this page",
 * or `allMatching` for "all 4.312 that match the filter" -- a deliberate
 * second click (SelectionBar's escalation button), never inferred from
 * checking every row on a page. The two never coexist: any change to the
 * specific-id set clears `allMatching`, because a claim of "everything" that
 * survives one unchecked row is a lie to whoever is about to act on it.
 */
type Selection = { ids: Set<string>; allMatching: boolean; total: number }

type SelectionApi = {
  selection: Selection
  toggleId: (id: string) => void
  togglePage: (ids: string[]) => void
  selectAllMatching: () => void
}

const SelectionContext = createContext<SelectionApi | null>(null)

function useSelectionApi(): SelectionApi {
  const ctx = useContext(SelectionContext)
  if (!ctx) throw new Error('list-selection: SelectRow/SelectAll/SelectionBar used outside <SelectionProvider>')
  return ctx
}

/** Wraps the list -- table and bulk-action bar alike -- in the one piece of
 *  client state a list otherwise has no reason to carry (§7). `total` is the
 *  count the CURRENT filter matches across every page, exactly what
 *  `listCustomers`-style results already report as `.total`. */
export function SelectionProvider({ total, children }: { total: number; children: ReactNode }) {
  const [ids, setIds] = useState<Set<string>>(new Set())
  const [allMatching, setAllMatching] = useState(false)

  const api = useMemo<SelectionApi>(() => ({
    selection: { ids, allMatching, total },
    toggleId: (id) => {
      setIds((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
      // Any change to a SPECIFIC id invalidates the all-matching claim --
      // it's only ever re-asserted by the deliberate escalation click.
      setAllMatching(false)
    },
    togglePage: (pageIds) => {
      setIds((prev) => {
        const allSelected = pageIds.length > 0 && pageIds.every((id) => prev.has(id))
        const next = new Set(prev)
        pageIds.forEach((id) => (allSelected ? next.delete(id) : next.add(id)))
        return next
      })
      setAllMatching(false)
    },
    selectAllMatching: () => setAllMatching(true),
  }), [ids, allMatching, total])

  return <SelectionContext.Provider value={api}>{children}</SelectionContext.Provider>
}

/** One row's checkbox. All this component knows is the id -- never a name
 *  or column -- so the label stays generic rather than guessing at a shape
 *  this module has no business reading. */
export function SelectRow({ id }: { id: string }) {
  const { selection, toggleId } = useSelectionApi()
  const domId = `select-row-${id}`
  return (
    <span className="inline-flex items-center">
      <Checkbox id={domId} checked={selection.ids.has(id)} onCheckedChange={() => toggleId(id)} />
      <Label htmlFor={domId} className="sr-only">Pilih baris ini</Label>
    </span>
  )
}

/** The header checkbox: selects or clears every id on THIS page, and only
 *  this page -- the all-matching escalation lives in SelectionBar alone, so
 *  ticking this can never silently reach past what's on screen. */
export function SelectAll({ ids }: { ids: string[] }) {
  const { selection, togglePage } = useSelectionApi()
  const checked = ids.length > 0 && ids.every((id) => selection.ids.has(id))
  return (
    <span className="inline-flex items-center">
      <Checkbox id="select-all" checked={checked} onCheckedChange={() => togglePage(ids)} />
      <Label htmlFor="select-all" className="sr-only">Pilih semua di halaman ini</Label>
    </span>
  )
}

/**
 * The count, the "select all N matching" escalation, and the submit.
 *
 * `action` is a Server Action FUNCTION passed as a prop -- `<form
 * action={fn}>` takes a function in the App Router, never a URL string.
 *
 * On submit the form posts either one `ids` input per selected row, or a
 * single `allMatching=1` -- never both -- plus whatever filter the list is
 * currently showing, via `preservedFields` (the same helper the GET filter
 * forms use): the all-matching mode acts on the FILTER, not a snapshot of
 * four thousand ids, and it must act on the view the person is looking at.
 */
export function SelectionBar({
  action, label,
}: {
  action: (formData: FormData) => Promise<void>
  label: string
}) {
  const { selection, selectAllMatching } = useSelectionApi()
  const params = Object.fromEntries(useSearchParams().entries())

  if (selection.ids.size === 0 && !selection.allMatching) return null

  const count = selection.allMatching ? selection.total : selection.ids.size
  const canEscalate = !selection.allMatching && selection.ids.size < selection.total

  return (
    <form action={action} className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/40 p-3">
      {preservedFields(params, ['ids', 'allMatching']).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {selection.allMatching
        ? <input type="hidden" name="allMatching" value="1" />
        : [...selection.ids].map((id) => <input key={id} type="hidden" name="ids" value={id} />)}

      <span data-testid="selection-count" className="text-sm font-medium tabular-nums">
        {count.toLocaleString('id-ID')} dipilih
      </span>

      {canEscalate && (
        <button
          type="button"
          onClick={selectAllMatching}
          className={buttonVariants({ variant: 'link', size: 'sm' })}
        >
          Pilih semua {selection.total.toLocaleString('id-ID')} yang cocok
        </button>
      )}

      <Button type="submit" variant="destructive" size="sm">{label}</Button>
    </form>
  )
}
