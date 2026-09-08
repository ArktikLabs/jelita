import { describe, expect, it } from 'vitest'
import type { SQL } from 'drizzle-orm'
import { clampPage, orderBy, parseListQuery, toResult, type ListSpec } from '../lib/list-query'

const SPEC: ListSpec = {
  sortable: { name: 'c.name', created: 'c.created_at' },
  defaultSort: 'name',
  tiebreak: 'c.id',
  searchable: true,
  filters: { active: ['true', 'false'] },
}

/**
 * Flatten a drizzle `SQL` fragment back to plain text, without a database.
 *
 * `sql` and `sql.raw` are pure object construction -- no connection, no
 * dialect -- they just build a tree of chunks (`{ value: [...] }` for a plain
 * string, `{ queryChunks: [...] }` for a nested SQL fragment from `sql.raw`
 * or an interpolated value). Concatenating that tree is exactly what a real
 * driver does before sending the string over the wire, so this asserts on
 * the same text Postgres would receive, with no live connection required --
 * which is what keeps this test file runnable against nothing.
 */
function render(chunk: unknown): string {
  if (chunk == null) return ''
  const c = chunk as { queryChunks?: unknown[]; value?: unknown[] }
  if (Array.isArray(c.queryChunks)) return c.queryChunks.map(render).join('')
  if (Array.isArray(c.value)) return c.value.join('')
  return String(chunk)
}

const renderOrderBy = (query: ReturnType<typeof parseListQuery>): string =>
  render(orderBy(SPEC, query) as SQL)

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

describe('orderBy', () => {
  // §3.3: a bare `order by name` over duplicate names is not deterministic
  // between two queries -- a row can appear on two pages and another on
  // none. The customers.db.test.ts paging test proves rows aren't lost in
  // practice on an unchanging table, but Postgres's tie order for such a
  // table is often stable run-to-run regardless -- so that test cannot prove
  // the tiebreaker is actually emitted. This asserts the emitted SQL text
  // directly instead.
  it('always ends the ORDER BY in the tiebreak column', () => {
    const asc = renderOrderBy(parseListQuery(SPEC, { sort: 'name' }))
    expect(asc).toContain(SPEC.tiebreak)
    expect(asc.trim().endsWith(SPEC.tiebreak)).toBe(true)
  })

  it('holds for both sort directions', () => {
    const asc = renderOrderBy(parseListQuery(SPEC, { sort: 'name' }))
    const desc = renderOrderBy(parseListQuery(SPEC, { sort: '-name' }))
    expect(asc.trim().endsWith(SPEC.tiebreak)).toBe(true)
    expect(desc.trim().endsWith(SPEC.tiebreak)).toBe(true)
    expect(asc).not.toBe(desc)
  })

  it('falls back to the default column, with its tiebreak, for an unknown sort', () => {
    // Same injection attempt as parseListQuery's own test above, carried
    // through to what actually reaches Postgres.
    const injected = "c.name; drop table customers --"
    const rendered = renderOrderBy(parseListQuery(SPEC, { sort: injected }))
    expect(rendered).not.toContain(injected)
    expect(rendered).toContain(SPEC.sortable[SPEC.defaultSort])
    expect(rendered.trim().endsWith(SPEC.tiebreak)).toBe(true)
  })
})

describe('toResult', () => {
  it('reports the page count, never fewer than one', () => {
    const q = parseListQuery(SPEC, {})
    expect(toResult([], 0, q).pages).toBe(1)
    expect(toResult([], 51, q).pages).toBe(3)
  })
})
