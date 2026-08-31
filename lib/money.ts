/**
 * Money is an integer in the currency's minor unit (spec 2.4). The exponent
 * varies -- IDR and JPY have 0, SGD and USD have 2 -- so 50000 is Rp 50.000
 * in an IDR salon and $500.00 in a USD one. Never a decimal: commission
 * divides money, and rounding a decimal type invites half-unit drift.
 */
export const SUPPORTED_CURRENCIES = {
  IDR: { exponent: 0, locale: 'id-ID' },
  SGD: { exponent: 2, locale: 'en-SG' },
  MYR: { exponent: 2, locale: 'ms-MY' },
  USD: { exponent: 2, locale: 'en-US' },
} as const

export type CurrencyCode = keyof typeof SUPPORTED_CURRENCIES

export const isCurrencyCode = (v: string): v is CurrencyCode =>
  Object.prototype.hasOwnProperty.call(SUPPORTED_CURRENCIES, v)

/** Minor units -> a display string in the salon's locale. */
export function formatMoney(minor: number, currency: CurrencyCode): string {
  const { exponent, locale } = SUPPORTED_CURRENCIES[currency]
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(minor / 10 ** exponent)
}

/**
 * A typed amount -> minor units. Returns null when the input is not a
 * non-negative number, so callers surface a form error rather than storing
 * NaN. Digits, one separator, nothing else.
 */
export function parseMoney(input: string, currency: CurrencyCode): number | null {
  const { exponent } = SUPPORTED_CURRENCIES[currency]
  const cleaned = input.trim().replace(/[.,\s]/g, (m, i, s) =>
    exponent > 0 && s.length - i - 1 === exponent ? '.' : '')
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null
  const scaled = Math.round(Number(cleaned) * 10 ** exponent)
  return Number.isFinite(scaled) && scaled >= 0 ? scaled : null
}
