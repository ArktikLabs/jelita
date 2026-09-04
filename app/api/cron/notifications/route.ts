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
 *
 * ## The cadence is ONCE A DAY, and that is a real limit
 *
 * vercel.json says `0 16 * * *` -- 23:00 in Jakarta -- because a Hobby-plan
 * cron fires once daily. Late in the salon's day on purpose: a day-before
 * reminder for tomorrow's 14:00 appointment comes due at 14:00 TODAY, so an
 * evening run still delivers it the day before. A morning run would not reach
 * it until the day of.
 *
 * What one daily run cannot do, stated rather than discovered:
 *
 *   - `reminder_2h` cannot be honoured at all. "Two hours before" needs a
 *     cadence finer than the gap it is trying to hit.
 *   - `booking_confirmed` is queued for immediate delivery and will instead
 *     wait up to a day, which for a confirmation is close to useless.
 *
 * Both work correctly the moment the schedule can run every 15 minutes; the
 * code does not change, only vercel.json. Until then the Notification
 * Center's button is how a confirmation actually goes out.
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
