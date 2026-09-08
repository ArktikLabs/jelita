import { sql, type SQL } from 'drizzle-orm'

/** Page sizes a URL may ask for. A free integer is a denial-of-service
 *  against our own database written in the query string. */
const PER_PAGE = [25, 50, 100] as const

export type ListSpec = {
  /**
   * Public sort name -> the SQL expression to order by.
   *
   * The VALUES here are written by us and never come from a request, which is
   * what makes `sql.raw` safe below. The KEYS are the entire vocabulary a URL
   * may use: anything else is not escaped, it simply does not exist.
   *
   * Spec §3.2: only declare a column here if an index supports it. This map is
   * a promise that ordering by the column is cheap.
   */
  sortable: Record<string, string>
  /** A key of `sortable`, optionally prefixed `-` for descending. */
  defaultSort: string
  /** The unique column appended to every ORDER BY. See §3.3. */
  tiebreak: string
  searchable?: boolean
  /** Filter name -> the values it accepts. Anything else is dropped. */
  filters?: Record<string, readonly string[]>
}

export type ListQuery = {
  page: number
  perPage: number
  /** A key of the spec's `sortable`. */
  sort: string
  desc: boolean
  q: string | null
  filters: Record<string, string>
}

export type ListResult<T> = {
  rows: T[]
  total: number
  page: number
  perPage: number
  pages: number
}

type Params = Record<string, string | string[] | undefined>

const one = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v

/**
 * The ONLY place a list reads searchParams.
 *
 * Everything is resolved against the spec rather than sanitised: an unknown
 * sort column, an unlisted page size and an undeclared filter are all simply
 * absent, so there is no escaping step to get wrong.
 */
export function parseListQuery(spec: ListSpec, params: Params): ListQuery {
  // Parsed from the raw string rather than coerced through Number: a float
  // coercion accepts things like `1e21` (Number.isInteger(1e21) is true) or
  // digit strings past bigint range, and paginate() below turns page into a
  // Postgres OFFSET -- a value Postgres cannot parse crashes the request with
  // a 500 instead of simply falling back to page 1. The regex makes the bad
  // state unrepresentable: only a plain run of digits, capped at 7 of them
  // (comfortably below where page * perPage could ever approach bigint
  // range), counts as a page number at all.
  const rawPage = one(params.page) ?? ''
  const page = /^[1-9]\d{0,6}$/.test(rawPage) ? Number(rawPage) : 1

  const rawPer = Number(one(params.per))
  const perPage = (PER_PAGE as readonly number[]).includes(rawPer) ? rawPer : PER_PAGE[0]

  const rawSort = one(params.sort) ?? spec.defaultSort
  const wanted = rawSort.startsWith('-') ? rawSort.slice(1) : rawSort
  const known = Object.hasOwn(spec.sortable, wanted)
  const fallback = spec.defaultSort.startsWith('-') ? spec.defaultSort.slice(1) : spec.defaultSort
  const sort = known ? wanted : fallback
  const desc = known ? rawSort.startsWith('-') : spec.defaultSort.startsWith('-')

  const rawQ = spec.searchable ? (one(params.q) ?? '').trim() : ''
  const q = rawQ === '' ? null : rawQ

  const filters: Record<string, string> = {}
  for (const [name, allowed] of Object.entries(spec.filters ?? {})) {
    const value = one(params[name])
    if (value !== undefined && allowed.includes(value)) filters[name] = value
  }

  return { page, perPage, sort, desc, q, filters }
}

/**
 * `sql.raw` is safe here and nowhere else: the expression comes from the
 * spec's own values, which are written in our source, and the request only
 * chose WHICH key to look up.
 *
 * The tiebreaker is not optional. `order by name` over duplicate names is not
 * deterministic between two queries, so a row can show on page 1 and again on
 * page 2 while another is never shown at all (§3.3).
 */
export function orderBy(spec: ListSpec, query: ListQuery): SQL {
  const column = spec.sortable[query.sort]
  return sql`order by ${sql.raw(column)} ${sql.raw(query.desc ? 'desc' : 'asc')}, ${sql.raw(spec.tiebreak)}`
}

export function paginate(query: ListQuery): SQL {
  return sql`limit ${query.perPage} offset ${(query.page - 1) * query.perPage}`
}

const pageCount = (total: number, perPage: number) =>
  Math.max(1, Math.ceil(total / perPage))

/** A page past the end serves the last page rather than an empty table. */
export function clampPage(query: ListQuery, total: number): ListQuery {
  const pages = pageCount(total, query.perPage)
  return query.page > pages ? { ...query, page: pages } : query
}

export function toResult<T>(rows: T[], total: number, query: ListQuery): ListResult<T> {
  return {
    rows,
    total,
    page: query.page,
    perPage: query.perPage,
    pages: pageCount(total, query.perPage),
  }
}
