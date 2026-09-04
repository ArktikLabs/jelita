import { processDue } from '@/lib/notify'

/**
 * The scheduler (PRD §5.5).
 *
 * Vercel Cron hits this on a timer and it sends every message that has come
 * due, for every salon. The Notification Center's button calls the same
 * `processDue` for one salon -- one code path, so the demo's manual override
 * and the real thing cannot drift.
 *
 * `processDue` takes `for update skip locked`, so a slow run overlapping the
 * next one cannot double-send.
 */
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  // REFUSES when unset rather than running openly. An unauthenticated endpoint
  // that dispatches messages is worth more to an attacker than to us, and the
  // failure mode of the safe default -- reminders stop -- is visible in the
  // Center, where a growing queue of due messages says exactly what is wrong.
  if (!secret) {
    return Response.json({ error: 'CRON_SECRET is not configured' }, { status: 503 })
  }

  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  const sent = await processDue()
  return Response.json({ sent })
}
