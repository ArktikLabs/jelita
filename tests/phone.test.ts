import { describe, expect, it } from 'vitest'
import { normalizePhone } from '../lib/phone'

describe('normalizePhone', () => {
  it('folds every spelling of one number onto one key', () => {
    const keys = ['0812345678', '+62 812 345 678', '62812345678', '0812-3456-78']
      .map(normalizePhone)
    expect(new Set(keys).size).toBe(1)
    expect(keys[0]).toBe('62812345678')
  })

  it('folds the mistyped 62-then-0 prefix', () => {
    // No legitimate Indonesian subscriber number has a 0 straight after the
    // country code, so this can only be someone typing both forms at once.
    expect(normalizePhone('620812345678')).toBe('62812345678')
  })

  it.each([
    ['0', 'a placeholder digit'],
    ['62', 'a bare country code'],
    ['+62', 'a country code with punctuation'],
  ])('refuses %s (%s) rather than producing a key', (input) => {
    // '0' and '62' both used to reduce to '62', so two unrelated blanks
    // collided and the second customer was refused for a reason nobody could
    // act on.
    expect(normalizePhone(input)).toBeNull()
  })

  it('refuses a number carrying an annotation instead of mangling it', () => {
    // Stripping non-digits would glue '12' onto the number, yielding a key
    // that matches nothing -- so booking would later create a SECOND record
    // for someone already in the database.
    expect(normalizePhone('0812-3456-7890 ext 12')).toBeNull()
  })

  it('still accepts a clean number with separators', () => {
    expect(normalizePhone('0812-3456-7890')).toBe('6281234567890')
  })

  it.each(['', 'abc', '   '])('returns null for %j', (input) => {
    expect(normalizePhone(input)).toBeNull()
  })
})
