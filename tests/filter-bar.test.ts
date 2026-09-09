import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { FilterBar } from '../components/list/filter-bar'
import type { ListQuery, ListSpec } from '../lib/list-query'

/**
 * Two function-form (validator-backed) filters, only one of which a page
 * would wire a `controls` entry for -- the exact shape of the review
 * finding: a filter that is function-typed in the spec but has no matching
 * control must still be preserved as a hidden field, not silently dropped
 * from the form's `own` exclusion list.
 */
const SPEC: ListSpec<'name'> = {
  sortable: { name: 'x.name' },
  defaultSort: 'name',
  tiebreak: 'x.id',
  filters: {
    date: (raw: string) => raw,
    other: (raw: string) => raw,
  },
}

describe('FilterBar', () => {
  it('preserves an unwired function-form filter as a hidden field, rather than silently dropping it on submit', () => {
    const query: ListQuery = {
      page: 1, perPage: 25, sort: 'name', desc: false, q: null,
      filters: { date: '2026-09-09', other: 'keep-me' },
    }
    const params = { date: '2026-09-09', other: 'keep-me' }
    const html = renderToStaticMarkup(createElement(FilterBar, {
      spec: SPEC,
      query,
      params,
      // Only `date` is wired -- `other` gets no rendered input, so a
      // hidden field is its ONLY way to survive this form's submit.
      controls: { date: { type: 'date', label: 'Tanggal' } },
    }))
    expect(html).toContain('name="other"')
    expect(html).toContain('value="keep-me"')
  })
})
