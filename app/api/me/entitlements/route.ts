import { currentEntitlements } from '@/lib/plan/entitlements'

const STATUS: Record<string, number> = {
  UNAUTHORIZED: 401,
  NO_ACTIVE_ORGANIZATION: 409,
}

export async function GET() {
  try {
    const { entitlements } = await currentEntitlements()
    return Response.json({
      planKey: entitlements.planKey,
      planName: entitlements.planName,
      status: entitlements.status,
      caps: entitlements.caps,
      features: [...entitlements.features],
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'ERROR'
    return Response.json({ error: msg }, { status: STATUS[msg] ?? 400 })
  }
}
