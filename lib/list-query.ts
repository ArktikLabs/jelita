import { sql, type SQL } from 'drizzle-orm'

/** Page sizes a URL may ask for. A free integer is a denial-of-service
 *  against our own database written in the query string. */
const PER_PAGE = [25, 50, 100] as const

/** A column's ordering. A plain string takes the query's direction appended;
 *  the object form is used when the two directions differ in more than the
 *  keyword -- a nullable column wanting `nulls last` both ways is the case
 *  that forced this. */
type SortExpr = string | { asc: string; desc: string }

/** What a filter accepts. The array form is the common case -- a fixed set of
 *  values -- and stays as it was. The function form is for values that are
 *  legal by SHAPE rather than by membership: a date, an id, a month. It
 *  returns the value to use, or null to drop the filter. */
export type FilterRule = readonly string[] | ((raw: string) => string | null)

export type ListSpec<K extends string = string> = {
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
  sortable: Record<K, SortExpr>
  /** A key of `sortable`, optionally prefixed `-` for descending. Generic, so
   *  a default naming a column that is not sortable is a compile error rather
   *  than a `sql.raw(undefined)` at runtime. */
  defaultSort: K | `-${K}`
  /** The unique column appended to every ORDER BY. See §3.3. */
  tiebreak: string
  searchable?: boolean
  /** Filter name -> the rule it must satisfy. Anything else is dropped. */
  filters?: Record<string, FilterRule>
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
export function parseListQuery<K extends string>(spec: ListSpec<K>, params: Params): ListQuery {
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
  for (const [name, rule] of Object.entries(spec.filters ?? {})) {
    const raw = one(params[name])
    if (raw === undefined) continue
    // Array form: membership. Function form: the validator's own verdict --
    // returning the value to keep or null to drop it. Either way the result
    // is bound as a PARAMETER by whoever builds the query's SQL next; nothing
    // returned here is ever handed to sql.raw.
    const value = typeof rule === 'function' ? rule(raw) : (rule.includes(raw) ? raw : null)
    // A rule that rejects the raw value leaves the filter ABSENT, not
    // present with an empty or invalid string -- so a resource's `where`
    // fragment can keep treating "not in filters" as "no restriction" for
    // every filter, exactly as it did before validators existed.
    if (value !== null) filters[name] = value
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
export function orderBy<K extends string>(spec: ListSpec<K>, query: ListQuery): SQL {
  const expr = spec.sortable[query.sort as K]
  const dir = query.desc ? 'desc' : 'asc'
  const column = typeof expr === 'string'
    ? `${expr} ${dir}`
    : (query.desc ? expr.desc : expr.asc)
  // The tiebreak takes the SORT's direction, not a fixed ascending: it is what
  // lets one plain btree serve both directions as an exact match.
  return sql`order by ${sql.raw(column)}, ${sql.raw(spec.tiebreak)} ${sql.raw(dir)}`
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
