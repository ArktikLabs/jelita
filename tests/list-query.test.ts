import { describe, expect, it } from 'vitest'
import { clampPage, parseListQuery, toResult, type ListSpec } from '../lib/list-query'

const SPEC: ListSpec = {
  sortable: { name: 'c.name', created: 'c.created_at' },
  defaultSort: 'name',
  tiebreak: 'c.id',
  searchable: true,
  filters: { active: ['true', 'false'] },
}

describe('parseListQuery', () => {
  it('falls back to the spec defaults when nothing is given', () => {
    const q = parseListQuery(SPEC, {})
    expect(q).toEqual({ page: 1, perPage: 25, sort: 'name', desc: false, q: null, filters: {} })
  })

  it('reads a page, a size from the allow-list, and a descending sort', () => {
    const q = parseListQuery(SPEC, { page: '3', per: '50', sort: '-created' })
    expect(q.page).toBe(3)
    expect(q.perPage).toBe(50)
    expect(q.sort).toBe('created')
    expect(q.desc).toBe(true)
  })

  it('refuses a page size that is not on the allow-list', () => {
    // A free ?per=100000 is a denial-of-service against our own database
    // written in the query string.
    expect(parseListQuery(SPEC, { per: '100000' }).perPage).toBe(25)
  })

  it('clamps a page below one', () => {
    expect(parseListQuery(SPEC, { page: '0' }).page).toBe(1)
    expect(parseListQuery(SPEC, { page: '-4' }).page).toBe(1)
    expect(parseListQuery(SPEC, { page: 'abc' }).page).toBe(1)
  })

  it('falls back to the default sort for a column that is not declared', () => {
    expect(parseListQuery(SPEC, { sort: 'salary' }).sort).toBe('name')
  })

  it('cannot be made to inject SQL, because the value is looked up not escaped', () => {
    const q = parseListQuery(SPEC, { sort: "c.name; drop table customers --" })
    expect(q.sort).toBe('name')
    // The point: the malicious string never becomes SQL because it is not a
    // key of spec.sortable. There is nothing to escape.
    expect(Object.keys(SPEC.sortable)).not.toContain("c.name; drop table customers --")
  })

  it('trims the search and treats blank as absent', () => {
    expect(parseListQuery(SPEC, { q: '  budi ' }).q).toBe('budi')
    expect(parseListQuery(SPEC, { q: '   ' }).q).toBeNull()
  })

  it('ignores a filter value that is not declared', () => {
    expect(parseListQuery(SPEC, { active: 'false' }).filters).toEqual({ active: 'false' })
    expect(parseListQuery(SPEC, { active: 'maybe' }).filters).toEqual({})
  })

  it('ignores an undeclared filter entirely', () => {
    expect(parseListQuery(SPEC, { salary: '999' }).filters).toEqual({})
  })
})

describe('clampPage', () => {
  it('pulls a page past the end back to the last page', () => {
    const q = parseListQuery(SPEC, { page: '999', per: '25' })
    expect(clampPage(q, 60).page).toBe(3)   // 60 rows / 25 = 3 pages
  })

  it('leaves an in-range page alone', () => {
    expect(clampPage(parseListQuery(SPEC, { page: '2' }), 60).page).toBe(2)
  })

  it('keeps page 1 when there are no rows at all', () => {
    expect(clampPage(parseListQuery(SPEC, { page: '4' }), 0).page).toBe(1)
  })
})

describe('toResult', () => {
  it('reports the page count, never fewer than one', () => {
    const q = parseListQuery(SPEC, {})
    expect(toResult([], 0, q).pages).toBe(1)
    expect(toResult([], 51, q).pages).toBe(3)
  })
})
