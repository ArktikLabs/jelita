import { toCsv } from './csv'
import { EXPORT_CAP, wasTruncated } from './list-query'

/**
 * One CSV response, so the cap notice and the headers are decided once rather
 * than six times.
 *
 * The truncation notice goes IN THE FILE, not only in the UI: the person who
 * opens the spreadsheet next week never saw the screen it was downloaded from,
 * and a short export that looks complete is exactly §8's "silently truncated
 * export is worse than a refused one".
 */
export function csvResponse(
  section: string,
  headers: string[],
  rows: (string | number | null)[][],
  total: number,
): Response {
  let body = toCsv(headers, rows)
  if (wasTruncated(total)) {
    body += toCsv([], [[
      `Dipotong pada ${EXPORT_CAP} baris dari ${total} yang cocok. ` +
      'Persempit filter untuk mengekspor sisanya.',
    ]])
  }
  const today = new Date().toISOString().slice(0, 10)
  return new Response(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="jelita-${section}-${today}.csv"`,
      'cache-control': 'no-store',
    },
  })
}
