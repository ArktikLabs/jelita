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
 * not yet countable — `products` has no table until the business schema
 * ships, and a cap that cannot be counted must not be silently treated as
 * satisfied.
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
  if (resource === 'services') {
    // Active only, like staff seats and unlike branches: a retired service
    // does nothing for the salon, so it should not hold a slot. Branches
    // count even when deactivated because freeing that slot would let a salon
    // cycle branches to evade the cap; a retired service retains no such value.
    const { rows } = await db.execute(sql`
      select count(*)::int as n from services
       where organization_id = ${organizationId} and active`)
    return (rows[0] as { n: number }).n
  }
  return null // products — still uncounted
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

  // This check is the FRIENDLY half. For STAFF the guarantee lives in the
  // database: `members_within_seat_cap` (migration 0026) refuses an insert
  // that would put a salon over its cap, counting seats exactly as
  // countResource does above.
  //
  // It had to go there for the same reason the ownerless guard did:
  // better-auth's addMember writes the members row through its own adapter, so
  // no application transaction covers both this count and that write. The
  // trigger takes `for update` on the organization row first -- without it two
  // concurrent inserts each count a snapshot excluding the other and both pass.
  //
  // This clause stays because a constraint error is not a message anyone
  // should read: it turns the common case into a PlanError carrying the cap
  // and the plan name, which is what the upgrade prompt renders.
  //
  // ponytail: BRANCHES and SERVICES still race here. A branch overshoot is
  // self-healing (branch_entitlement recomputes which are within cap, so the
  // extra one is simply locked); a service overshoot is a stale count until
  // someone retires one. Same fix shape as 0026 when either matters.
  if (used >= cap) {
    throw new PlanError('QUOTA_EXCEEDED', {
      resource, cap, used,
      planKey: entitlements.planKey,
      planName: entitlements.planName,
    })
  }
}
