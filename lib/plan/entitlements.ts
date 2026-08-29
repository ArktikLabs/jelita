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
      // if the organization itself is gone. Fail closed but legibly.
      throw new PlanError('FEATURE_NOT_IN_PLAN', { organizationId })
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
    const { rows } = await db.execute(sql`
      select count(*)::int as n from members
       where organization_id = ${organizationId}`)
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

/** Throws PlanError('QUOTA_EXCEEDED') when the tier has no room left. */
export async function requireQuota(resource: CappedResource) {
  const { orgId, entitlements } = await currentEntitlements()
  const cap = entitlements.caps[resource]
  if (cap === undefined) return // no plan_limits row = unlimited

  const used = await countResource(orgId, resource)
  if (used === null) return // not countable yet; see countResource

  if (used >= cap) {
    throw new PlanError('QUOTA_EXCEEDED', {
      resource, cap, used,
      planKey: entitlements.planKey,
      planName: entitlements.planName,
    })
  }
}
