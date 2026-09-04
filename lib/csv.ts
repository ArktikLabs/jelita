/**
 * CSV, for §5.6's export.
 *
 * EVERY field is quoted, including numbers. One rule instead of "quote when it
 * contains a comma, a quote, a newline, or leading whitespace" -- that
 * condition is four chances to miss a case, and a missed case is not an error
 * but a silently wrong spreadsheet, with one row's columns shifted.
 *
 * Internal quotes are doubled, per RFC 4180.
 *
 * The BOM is for Excel: without it, Excel on Windows reads a UTF-8 file as
 * the local codepage and an Indonesian salon's names come out mangled. Six
 * bytes to avoid the most likely first impression of this feature.
 */
const BOM = '﻿'

const field = (v: unknown): string => {
  if (v === null || v === undefined) return '""'
  return `"${String(v).replace(/"/g, '""')}"`
}

export function toCsv(
  headers: string[], rows: (string | number | null)[][],
): string {
  // CRLF, which RFC 4180 specifies and Excel is happiest with.
  return BOM + [headers, ...rows].map((r) => r.map(field).join(',')).join('\r\n') + '\r\n'
}

/** A filename that says what and when, so a folder of them is still readable. */
export const csvFilename = (section: string, from: string, to: string) =>
  `jelita-${section}-${from}-${to}.csv`
