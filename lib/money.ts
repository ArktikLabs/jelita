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

/**
 * Minor units -> a display string in the salon's locale, symbol included.
 * DISPLAY ONLY -- never feed this back into parseMoney (it round-trips
 * through toAmountInput instead, which has no symbol or grouping to strip).
 */
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
 * Minor units -> a bare numeric string for a form field's value: no symbol,
 * no grouping, '.' as the decimal separator. The counterpart to parseMoney
 * that formatMoney is not -- what a price input prefills and reads back.
 */
export function toAmountInput(minor: number, currency: CurrencyCode): string {
  const { exponent } = SUPPORTED_CURRENCIES[currency]
  return (minor / 10 ** exponent).toFixed(exponent)
}

/**
 * A typed amount -> minor units. No separator-position guessing: a lone
 * '.' or ',' is always grouping for a 0-exponent currency, and for a
 * 2-exponent currency only a trailing '.' followed by 1-2 digits is ever a
 * decimal point. An amount like '1.500' for USD is genuinely ambiguous
 * (1,500 or 1.50?) and is refused rather than silently guessed either way.
 * Returns null when the input doesn't match, so callers surface a form
 * error rather than storing NaN or a 10x-wrong amount.
 */
export function parseMoney(input: string, currency: CurrencyCode): number | null {
  const { exponent } = SUPPORTED_CURRENCIES[currency]
  const trimmed = input.trim()
  if (exponent === 0) {
    // A 0-exponent currency has no minor units, so a trailing '.NN'/',NN'
    // is one of two things, and they are NOT treated the same. A zero
    // fraction ('150.000,00') has exactly one sensible reading -- id-ID's
    // own formatting writes it that way for a plain 150.000 -- so it is
    // decorative and safe to drop. A non-zero fraction ('1.50') is genuinely
    // ambiguous: it could be 1.50 (impossible for this currency, but that's
    // what it looks like) or 150 with '.' as a grouping separator, and
    // nothing distinguishes them, so it is refused rather than guessed --
    // the same call '1.500' gets below for a 2-exponent currency.
    const fractionMatch = trimmed.match(/^(.*)[.,](\d{1,2})$/)
    if (fractionMatch) {
      const [, integerPart, fraction] = fractionMatch
      if (!/^0+$/.test(fraction)) return null
      const cleaned = integerPart.replace(/[.,\s]/g, '')
      if (!/^\d+$/.test(cleaned)) return null
      return Number(cleaned)
    }
    const cleaned = trimmed.replace(/[.,\s]/g, '')
    if (!/^\d+$/.test(cleaned)) return null
    return Number(cleaned)
  }
  const cleaned = trimmed.replace(/[,\s]/g, '')
  if (!new RegExp(`^\\d+(\\.\\d{1,${exponent}})?$`).test(cleaned)) return null
  return Math.round(Number(cleaned) * 10 ** exponent)
}
