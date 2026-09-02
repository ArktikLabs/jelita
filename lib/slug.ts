/**
 * A salon's slug is its SUBDOMAIN (`ovarya.atjelita.com/book`), so it has to
 * be a legal DNS label, not merely a tidy URL segment. These three rules were
 * harmless while the slug only appeared in an API path.
 *
 * No imports, deliberately: the rule is pure, and both the onboarding action
 * and the check suite call the same function rather than re-deriving it.
 */

/** RFC 1035: a label is at most 63 octets. */
const MAX_LENGTH = 63

/**
 * Hostnames that must never resolve to a salon. A DENY-list is the only shape
 * available here -- the set of legal salon names is open, so nothing can be
 * allow-listed -- which is why it errs wide: an unnecessary refusal costs a
 * salon one retry at signup, and a missing one hands somebody `www`.
 *
 * `localhost` is on it because dev serves tenants at `<slug>.localhost`.
 */
const RESERVED = new Set([
  'www', 'app', 'api', 'admin', 'auth', 'login', 'signup', 'register',
  'dashboard', 'book', 'booking', 'mail', 'smtp', 'imap', 'ftp', 'ns', 'ns1',
  'ns2', 'mx', 'cdn', 'static', 'assets', 'img', 'images', 'media', 'files',
  'support', 'help', 'status', 'blog', 'docs', 'dev', 'staging', 'test',
  'demo', 'localhost',
])

export type SlugProblem = 'required' | 'chars' | 'edges' | 'length' | 'reserved'

/**
 * Returns what is wrong with `slug`, or null when nothing is.
 *
 * A code rather than a message: the copy is Indonesian and belongs with the
 * form, and a caller that typed `www` needs different advice from one that
 * typed `Ovarya!`.
 */
export function slugProblem(slug: string): SlugProblem | null {
  if (!slug) return 'required'
  // Checked before the character rule so an over-long slug is not reported as
  // having bad characters when it has none.
  if (slug.length > MAX_LENGTH) return 'length'
  if (!/^[a-z0-9-]+$/.test(slug)) return 'chars'
  // A hyphen at either end is not a legal label, and passes the rule above.
  if (slug.startsWith('-') || slug.endsWith('-')) return 'edges'
  if (RESERVED.has(slug)) return 'reserved'
  return null
}
