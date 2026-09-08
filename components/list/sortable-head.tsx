import Link from 'next/link'
import { listHref } from '@/lib/list-url'
import { TableHead } from '@/components/ui/table'
import type { ListQuery, ListSpec } from '@/lib/list-query'

/**
 * A column header that sorts. A link, not a button: the state is the URL, so
 * this is navigation and the browser should treat it as such -- middle-click,
 * open in a new tab and back all work for free.
 */
export function SortableHead({
  column, label, spec, query, params,
}: {
  column: string
  label: string
  spec: ListSpec
  query: ListQuery
  params: Record<string, string | string[] | undefined>
}) {
  const isActive = query.sort === column
  // Clicking the active column flips it; clicking a new one starts ascending.
  const next = isActive && !query.desc ? `-${column}` : column
  return (
    <TableHead aria-sort={isActive ? (query.desc ? 'descending' : 'ascending') : 'none'}>
      <Link href={listHref(params, { sort: next })} className="inline-flex items-center gap-1 hover:underline">
        {label}
        <span aria-hidden className="text-muted-foreground">
          {isActive ? (query.desc ? '↓' : '↑') : ''}
        </span>
      </Link>
    </TableHead>
  )
}
