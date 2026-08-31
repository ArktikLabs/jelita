import { cache } from 'react'
import { sql } from 'drizzle-orm'
import { db } from '../db'
import { requireUser } from '../session'
import type { CappedResource, FeatureKey } from './catalog'

export type PlanErrorCode =
  | 'FEATURE_NOT_IN_PLAN'
  | 'QUOTA_EXCEEDED'
  | 'BRANCH_LOCKED'

export class PlanError extends Error {
  constructor(
    public code: PlanErrorCode,
    public meta: Record<string, unknown> = {},
  ) {
    super(code)
    this.name = 'PlanError'
  }
}

export type Entitlements = {
  planKey: string
  planName: string
  status: string
  caps: Partial<Record<CappedResource, number>>
  features: Set<FeatureKey>
}

/**
 * Storage is normalized; the read is not. One query returns caps as a JSON
 * object and features as an array so no guard joins at call time.
 * Memoised per request: a page calling several guards issues one query.
 */
export const getEntitlements = cache(
  async (organizationId: string): Promise<Entitlements> => {
    const { rows } = await db.execute(sql`
      select p.key as plan_key, p.name as plan_name, s.status,
             (select coalesce(json_object_agg(l.resource, l.cap), '{}')
                from plan_limits l where l.plan_id = p.id) as caps,
             (select coalesce(json_agg(f.feature_key), '[]')
                from plan_features f where f.plan_id = p.id) as features
        from effective_plan e
        join plans p on p.id = e.plan_id
        left join subscriptions s on s.organization_id = e.organization_id
       where e.organization_id = ${organizationId}
       limit 1
    `)

    const row = rows[0] as
      | { plan_key: string; plan_name: string; status: string | null
          caps: Record<string, number>; features: string[] }
      | undefined

    if (!row) {
      // effective_plan falls back to the default plan, so this only happens
      // if the organization itself is gone. That is a missing tenant, not a
      // tier problem — a PlanError here would surface as a 402 about a plan
      // that does not exist.
      throw new Error('ORGANIZATION_NOT_FOUND')
    }

    return {
      planKey: row.plan_key,
      planName: row.plan_name,
      status: row.status ?? 'active',
      caps: row.caps as Partial<Record<CappedResource, number>>,
      features: new Set(row.features as FeatureKey[]),
    }
  },
)

/** Entitlements for the caller's active organization. */
export async function currentEntitlements() {
  const session = await requireUser()
  const orgId = session.session.activeOrganizationId
  if (!orgId) throw new Error('NO_ACTIVE_ORGANIZATION')
  return { session, orgId, entitlements: await getEntitlements(orgId) }
}

/**
 * Current usage for a capped resource. Returns null when the resource is
 * not yet countable — `services` and `products` have no tables until the
 * business schema ships, and a cap that cannot be counted must not be
 * silently treated as satisfied.
 */
export async function countResource(
  organizationId: string,
  resource: CappedResource,
): Promise<number | null> {
  if (resource === 'branches') {
    const { rows } = await db.execute(sql`
      select count(*)::int as n from teams
       where organization_id = ${organizationId}`)
    return (rows[0] as { n: number }).n
  }
  if (resource === 'staff') {
    // Counts members who can actually work. A departed stylist releases their
    // seat (spec §2.4); the owner keeps theirs. coalesce(..., true) so a member
    // with no profile row still counts -- a missing row must never silently
    // hand out a free seat.
    const { rows } = await db.execute(sql`
      select count(*)::int as n from members m
       where m.organization_id = ${organizationId}
         and coalesce((select s.active from staff_profiles s
                        where s.user_id = m.user_id
                          and s.organization_id = m.organization_id), true)`)
    return (rows[0] as { n: number }).n
  }
  return null // services, products — Task 9
}

/** Throws PlanError('FEATURE_NOT_IN_PLAN') unless the tier includes `key`. */
export async function requireFeature(key: FeatureKey) {
  const { entitlements } = await currentEntitlements()
  if (!entitlements.features.has(key)) {
    throw new PlanError('FEATURE_NOT_IN_PLAN', {
      feature: key,
      planKey: entitlements.planKey,
      planName: entitlements.planName,
    })
  }
}

/**
 * Throws PlanError('QUOTA_EXCEEDED') when the tier has no room left.
 *
 * `organizationId` is optional and defaults to the caller's active org.
 * It must be passed explicitly for endpoints like accept-invitation, where
 * the acting session's active org has nothing to do with the org whose
 * quota is at stake (the invitee usually has no active org yet).
 */
export async function requireQuota(resource: CappedResource, organizationId?: string) {
  const orgId = organizationId ?? (await currentEntitlements()).orgId
  const entitlements = await getEntitlements(orgId)
  const cap = entitlements.caps[resource]
  if (cap === undefined) return // no plan_limits row = unlimited

  const used = await countResource(orgId, resource)
  if (used === null) return // not countable yet; see countResource

  // ponytail: check-then-act, no unique constraint behind it — two concurrent
  // creates at used = cap - 1 both pass and the tenant lands one seat over.
  // Ceiling: an off-by-one overshoot per race, self-healing for branches (the
  // view recomputes lock state) but not for seats. Upgrade path: a
  // `members`-counting exclusion/trigger constraint, or serialize seat creation
  // per organization (advisory lock on organization_id) if it ever matters.
  if (used >= cap) {
    throw new PlanError('QUOTA_EXCEEDED', {
      resource, cap, used,
      planKey: entitlements.planKey,
      planName: entitlements.planName,
    })
  }
}
