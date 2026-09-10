import { describe, expect, it } from 'vitest'
import { csvResponse } from '../lib/list-csv'
import { EXPORT_CAP } from '../lib/list-query'

// `Response#text()` decodes via "UTF-8 decode", which silently swallows a
// LEADING byte-order mark -- exactly the mark this response relies on for
// Excel. `ignoreBOM: true` keeps every BOM byte in the string, the same as
// a real download landing on disk, so a stray SECOND one (the bug this
// file's tests exist to catch) stays visible.
const body = async (r: Response) =>
  new TextDecoder('utf-8', { ignoreBOM: true }).decode(await r.arrayBuffer())

describe('csvResponse', () => {
  it('hands the browser a download, not a page', async () => {
    const r = csvResponse('pelanggan', ['Nama'], [['Sari']], 1)
    expect(r.headers.get('content-type')).toContain('text/csv')
    expect(r.headers.get('content-disposition')).toContain('attachment')
    expect(r.headers.get('content-disposition')).toContain('.csv')
    // A list is a snapshot of a moment; a cached one is a wrong one.
    expect(r.headers.get('cache-control')).toBe('no-store')
  })

  it('says so IN THE FILE when the cap bit', async () => {
    // A truncated export that looks complete is the failure this line exists
    // to prevent -- the person reading it in Excel never sees the UI notice.
    const rows = [['Sari']]
    const text = await body(csvResponse('pelanggan', ['Nama'], rows, EXPORT_CAP + 5))
    expect(text).toContain(String(EXPORT_CAP))
    expect(text.toLowerCase()).toContain('dipotong')

    // Substring checks alone would pass on a malformed file -- a second
    // toCsv call for the notice prepends a SECOND BOM and leaves a
    // BOM-only row between the data and the notice. Assert the shape
    // directly so that regression can't sneak back in silently.
    const lines = text.split('\r\n').filter((l) => l.length > 0)
    expect(text.match(/\uFEFF/g)?.length).toBe(1)
    for (const line of lines) expect(line.replace(/\uFEFF/g, '')).not.toBe('')
    const headerFields = lines[0].split(',').length
    const noticeFields = lines.at(-1)!.split(',').length
    expect(noticeFields).toBe(headerFields)
  })

  it('says nothing extra when it did not', async () => {
    const text = await body(csvResponse('pelanggan', ['Nama'], [['Sari']], 1))
    expect(text.toLowerCase()).not.toContain('dipotong')
    expect(text).toContain('Sari')
  })
})
