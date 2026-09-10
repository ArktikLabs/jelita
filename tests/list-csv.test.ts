import { describe, expect, it } from 'vitest'
import { csvResponse } from '../lib/list-csv'
import { EXPORT_CAP } from '../lib/list-query'

const body = async (r: Response) => await r.text()

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
  })

  it('says nothing extra when it did not', async () => {
    const text = await body(csvResponse('pelanggan', ['Nama'], [['Sari']], 1))
    expect(text.toLowerCase()).not.toContain('dipotong')
    expect(text).toContain('Sari')
  })
})
