/**
 * Phone normalisation, in its own file with NO imports so the check suite can
 * load it directly under Node's type-stripping. lib/customer.ts imports ./db,
 * which cannot be loaded that way -- the same split lib/money.ts uses.
 *
 * One rule, one place: booking will call findOrCreateByPhone rather than
 * inventing a second normalisation, because two rules that disagree produce
 * duplicate customers that look identical to a human.
 */

// 62 + a 9-to-13 digit subscriber number. Anything shorter is a placeholder or
// an abandoned entry, not a number: '0' and '62' both reduce to '62', so
// without a floor two unrelated blanks collide on one key and the second
// customer is refused for a nonsensical reason.
const MIN_KEY_LENGTH = 10
const MAX_KEY_LENGTH = 15

/**
 * Indonesian mobile numbers, canonicalised to 62-prefixed digits.
 * Returns null for anything that is not plausibly one number, so the caller
 * surfaces a form error and the operator retypes it.
 */
export function normalizePhone(input: string): string | null {
  const trimmed = input.trim()
  // Letters mean an annotation rode along -- "0812-3456-7890 ext 12", a name
  // pasted from a contact card. Stripping non-digits would glue the trailing
  // digits onto the number and produce a key that matches nothing, so booking
  // would later create a SECOND record for the same person. Refuse instead.
  if (/[a-z]/i.test(trimmed)) return null

  const digits = trimmed.replace(/\D/g, '')
  if (!digits) return null

  // 0812... is the domestic form of 62812...; 620812... is a mis-typed mix of
  // both, which people do produce, so fold it too. No legitimate Indonesian
  // subscriber number has a 0 immediately after the 62 country code.
  const key = digits.startsWith('620') ? `62${digits.slice(3)}`
    : digits.startsWith('62') ? digits
    : digits.startsWith('0') ? `62${digits.slice(1)}`
    : digits

  if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH) return null
  return key
}
