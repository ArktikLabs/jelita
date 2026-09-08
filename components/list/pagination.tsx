import Link from 'next/link'
import { listHref } from '@/lib/list-url'
import { buttonVariants } from '@/components/ui/button'
import type { ListResult } from '@/lib/list-query'

/** "1–25 dari 4.312" plus previous/next. Rendered only when there is more
 *  than one page -- a single-page list needs no controls. */
export function Pagination({
  result, params,
}: {
  result: ListResult<unknown>
  params: Record<string, string | string[] | undefined>
}) {
  const from = (result.page - 1) * result.perPage + 1
  const to = Math.min(result.page * result.perPage, result.total)
  if (result.total === 0) return null

  return (
    <nav aria-label="Halaman" className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm text-muted-foreground tabular-nums">
        {from}–{to} dari {result.total.toLocaleString('id-ID')}
      </p>
      {result.pages > 1 && (
        <div className="flex items-center gap-2">
          {result.page > 1 && (
            <Link
              href={listHref(params, { page: String(result.page - 1) })}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              Sebelumnya
            </Link>
          )}
          <span className="text-sm text-muted-foreground tabular-nums">
            {result.page} / {result.pages}
          </span>
          {result.page < result.pages && (
            <Link
              href={listHref(params, { page: String(result.page + 1) })}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              Berikutnya
            </Link>
          )}
        </div>
      )}
    </nav>
  )
}
