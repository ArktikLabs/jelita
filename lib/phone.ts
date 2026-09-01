/**
 * Phone normalisation, in its own file with NO imports so the check suite can
 * load it directly under Node's type-stripping. lib/customer.ts imports ./db,
 * which cannot be loaded that way -- the same split lib/money.ts uses.
 *
 * One rule, one place: booking will call findOrCreateByPhone rather than
 * inventing a second normalisation, because two rules that disagree produce
 * duplicate customers that look identical to a human.
 */

/** Indonesian mobile numbers, canonicalised to 62-prefixed digits. */
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/\D/g, '')
  if (!digits) return null
  // 0812... is the domestic form of 62812...; 620812... is a mis-typed mix of
  // both, which people do produce, so fold it too.
  if (digits.startsWith('620')) return `62${digits.slice(3)}`
  if (digits.startsWith('62')) return digits
  if (digits.startsWith('0')) return `62${digits.slice(1)}`
  return digits
}
