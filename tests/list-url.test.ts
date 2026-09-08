import { describe, expect, it } from 'vitest'
import { listHref } from '../lib/list-url'

describe('listHref', () => {
  it('keeps the parameters it was not asked to change', () => {
    // Searching must not silently clear the filters, and sorting must not
    // clear the search. Every control goes through here for exactly this.
    const href = listHref({ q: 'budi', active: 'false', page: '2' }, { sort: '-created' })
    expect(href).toContain('q=budi')
    expect(href).toContain('active=false')
    expect(href).toContain('sort=-created')
  })

  it('resets the page whenever the result set changes', () => {
    // Otherwise the user lands on page 7 of a two-page result and sees an
    // empty table that looks like a bug.
    expect(listHref({ page: '7' }, { sort: 'name' })).not.toContain('page=')
    expect(listHref({ page: '7' }, { q: 'budi' })).not.toContain('page=')
    expect(listHref({ page: '7' }, { active: 'true' })).not.toContain('page=')
  })

  it('keeps the page when only the page changes', () => {
    expect(listHref({ q: 'budi', page: '2' }, { page: '3' })).toContain('page=3')
  })

  it('drops a parameter set to null', () => {
    expect(listHref({ q: 'budi', active: 'false' }, { active: null })).not.toContain('active')
  })

  it('returns a bare path when nothing is set', () => {
    expect(listHref({}, {})).toBe('?')
  })
})
