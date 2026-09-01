import { describe, expect, it } from 'vitest'
import { formatMoney, parseMoney, toAmountInput } from '../lib/money'

describe('parseMoney', () => {
  // A wrong number is far worse than a refusal: it is stored, charged and
  // never questioned. Every case here was found by running the function
  // rather than reading it.
  it.each([
    ['150.000', 'IDR', 150000],
    ['1.500.000', 'IDR', 1500000],
    ['150.000,00', 'IDR', 150000],
    ['150000,00', 'IDR', 150000],
    ['0', 'IDR', 0],
    ['150.5', 'USD', 15050],
    ['150.50', 'USD', 15050],
    ['1,500.50', 'USD', 150050],
    ['150', 'USD', 15000],
    ['9.5', 'USD', 950],
  ] as const)('parses %s (%s) to %i', (input, currency, expected) => {
    expect(parseMoney(input, currency)).toBe(expected)
  })

  it.each([
    ['1.50', 'IDR'],   // 1.50 or 150? no rule distinguishes them
    ['1.500', 'USD'],  // 1,500 or 1.50?
    ['-5', 'IDR'],
    ['abc', 'IDR'],
    ['', 'USD'],
  ] as const)('refuses ambiguous or invalid %s (%s)', (input, currency) => {
    expect(parseMoney(input, currency)).toBeNull()
  })
})

describe('the form round trip', () => {
  // The detail screen renders a stored price into a field and reads it back on
  // save. If this breaks, an untouched field rewrites the price.
  it.each([
    ['IDR', [0, 1, 150000, 1500000, 123456789]],
    ['USD', [0, 5, 15050, 999999, 123456789]],
  ] as const)('%s survives toAmountInput -> parseMoney', (currency, amounts) => {
    for (const amount of amounts) {
      expect(parseMoney(toAmountInput(amount, currency), currency)).toBe(amount)
    }
  })

  it('formatMoney output is NOT parseable, by design', () => {
    // It carries the currency symbol; it is for display only. Feeding it back
    // must fail loudly rather than silently yielding a wrong number.
    expect(parseMoney(formatMoney(150000, 'IDR'), 'IDR')).toBeNull()
    expect(parseMoney(formatMoney(15050, 'USD'), 'USD')).toBeNull()
  })
})
