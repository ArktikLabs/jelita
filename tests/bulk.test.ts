import { describe, expect, it } from 'vitest'
import { bulkMessage } from '../lib/bulk'
import { EXPORT_CAP } from '../lib/list-query'

/**
 * `bulkMessage`'s copy, pure -- no database. `resolveSelection`'s own
 * behaviour (deriving `capped` from the list's `total`) is proven against
 * real Postgres in tests/bulk.db.test.ts.
 */
describe('bulkMessage', () => {
  it('says only the count when nothing was refused and nothing was capped', () => {
    expect(bulkMessage({ done: 3, refused: 0, total: 3 }, '')).toBe('3 dinonaktifkan.')
  })

  it('names the refusal reason when something was refused', () => {
    expect(bulkMessage({ done: 1, refused: 1, total: 2 }, 'pemilik terakhir'))
      .toBe('1 dinonaktifkan, 1 ditolak (pemilik terakhir).')
  })

  it('adds a third sentence when "all matching" hit the export cap', () => {
    // §7/§8: a capped selection leaves rows that are neither done nor
    // refused -- silent about that is indistinguishable from "that was
    // everything", which is the failure this sentence exists to prevent.
    const msg = bulkMessage({ done: EXPORT_CAP, refused: 0, total: EXPORT_CAP }, '', true)
    expect(msg).toContain(`${EXPORT_CAP} dinonaktifkan.`)
    expect(msg).toContain(String(EXPORT_CAP))
    expect(msg.toLowerCase()).toContain('dibatasi')
    expect(msg.toLowerCase()).toContain('jalankan lagi')
  })

  it('names both the refusal and the cap when both happened', () => {
    const msg = bulkMessage({ done: 5, refused: 1, total: 6 }, 'pemilik terakhir', true)
    expect(msg).toContain('ditolak')
    expect(msg.toLowerCase()).toContain('dibatasi')
  })

  it('says nothing about the cap when it did not bite', () => {
    const msg = bulkMessage({ done: 3, refused: 0, total: 3 }, '', false)
    expect(msg.toLowerCase()).not.toContain('dibatasi')
  })
})
