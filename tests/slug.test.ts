import { describe, expect, it } from 'vitest'
import { slugProblem } from '../lib/slug'

/**
 * A slug is a subdomain, so these are DNS rules, not cosmetics. Pure: no
 * database, no fixtures.
 */
describe('slugProblem', () => {
  it('accepts an ordinary salon slug', () => {
    expect(slugProblem('ovarya')).toBeNull()
    expect(slugProblem('salon-ovarya-2')).toBeNull()
  })

  it('refuses characters that cannot appear in a hostname', () => {
    for (const bad of ['Ovarya', 'ovarya.corp', 'ovarya_corp', 'ovarya salon', 'ovarya!']) {
      expect(slugProblem(bad), bad).toBe('chars')
    }
  })

  it('refuses a hyphen at either end -- legal characters, illegal label', () => {
    expect(slugProblem('-ovarya')).toBe('edges')
    expect(slugProblem('ovarya-')).toBe('edges')
    // ...but not in the middle, which is the common case.
    expect(slugProblem('ovarya-corp')).toBeNull()
  })

  it('refuses more than 63 characters, and accepts exactly 63', () => {
    expect(slugProblem('a'.repeat(63))).toBeNull()
    expect(slugProblem('a'.repeat(64))).toBe('length')
  })

  it('reports length before characters, so an over-long slug is not mislabelled', () => {
    // Both wrong. The message a user acts on should be the one they can fix.
    expect(slugProblem('A'.repeat(64))).toBe('length')
  })

  it('refuses the hostnames that must never be a salon', () => {
    for (const reserved of ['www', 'api', 'admin', 'book', 'mail', 'localhost']) {
      expect(slugProblem(reserved), reserved).toBe('reserved')
    }
  })

  it('refuses an empty slug distinctly from a malformed one', () => {
    expect(slugProblem('')).toBe('required')
  })
})
