import Link from 'next/link'
import { requirePagePermission, requirePageOrg, requireBranch } from '@/lib/session'
import { branchOpenWindow, listBookingsBetween } from '@/lib/booking'
import { listStaff } from '@/lib/staff'
import { buttonVariants } from '@/components/ui/button'
import { CalendarGrid, type Block, type Lane } from './calendar-grid'

/**
 * PRD 5.1's calendar view (day/week) per staff.
 *
 * Two layouts over one query, because they answer different questions:
 *   day  -- one column per stylist: "who is free at 3pm?" (the front desk's)
 *   week -- one column per day for ONE stylist: "when is Rina next open?"
 *
 * Reading only. Every write still goes through the list and the reschedule
 * form -- drag-and-drop is post-MVP, and a calendar that cannot write needs no
 * client state at all.
 */
const DAY_MS = 86_400_000

const iso = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const todayLocal = () => iso(new Date())

/** Minutes from midnight of a 'YYYY-MM-DDTHH:MM' wall-clock string. */
const minutesOf = (t: string) => Number(t.slice(11, 13)) * 60 + Number(t.slice(14, 16))

/** Monday of the week containing `date`. */
const weekStart = (date: string) => {
  const d = new Date(`${date}T00:00:00`)
  const back = (d.getDay() + 6) % 7
  return iso(new Date(d.getTime() - back * DAY_MS))
}

const addDays = (date: string, n: number) =>
  iso(new Date(new Date(`${date}T00:00:00`).getTime() + n * DAY_MS))

const WEEKDAYS = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min']

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; view?: string; staffUserId?: string }>
}) {
  await requirePagePermission({ booking: ['read'] })
  const { organizationId } = await requirePageOrg()
  // The branch comes from the session, never a query string -- the same rule
  // the day list follows.
  const { branchId } = await requireBranch()
  const q = await searchParams

  const date = /^\d{4}-\d{2}-\d{2}$/.test(q.date ?? '') ? q.date! : todayLocal()
  const week = q.view === 'week'
  const from = week ? weekStart(date) : date
  const to = week ? addDays(from, 7) : addDays(from, 1)

  const staff = (await listStaff(organizationId))
    .filter((s) => s.active && s.teamId === branchId)
  const staffUserId = staff.some((s) => s.userId === q.staffUserId)
    ? q.staffUserId!
    : staff[0]?.userId ?? ''

  const [bookings, window] = await Promise.all([
    listBookingsBetween(organizationId, branchId, from, to),
    branchOpenWindow(branchId, from, to),
  ])

  const lanes: Lane[] = week
    ? Array.from({ length: 7 }, (_, i) => {
      const d = addDays(from, i)
      return { key: d, label: `${WEEKDAYS[i]} ${d.slice(8)}` }
    })
    : staff.map((s) => ({ key: s.userId, label: s.name }))

  const shown = week ? bookings.filter((b) => b.staffUserId === staffUserId) : bookings
  const blocks: Block[] = shown.map((b) => ({
    id: b.id,
    lane: week ? b.day : b.staffUserId,
    startMin: minutesOf(b.startsAt),
    endMin: minutesOf(b.endsAt),
    title: b.customerName,
    subtitle: week ? b.serviceName : `${b.serviceName}`,
    status: b.status,
  }))

  const link = (over: Record<string, string>) => {
    const p = new URLSearchParams({
      date, view: week ? 'week' : 'day', ...(staffUserId ? { staffUserId } : {}), ...over,
    })
    return `/dashboard/bookings/calendar?${p}`
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-medium">Kalender</h1>
        <div className="flex items-center gap-2">
          <Link href={link({ view: 'day' })} className={buttonVariants({ variant: week ? 'outline' : 'default', size: 'sm' })}>
            Harian
          </Link>
          <Link href={link({ view: 'week' })} className={buttonVariants({ variant: week ? 'default' : 'outline', size: 'sm' })}>
            Mingguan
          </Link>
          <Link href={`/dashboard/bookings?date=${date}`} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Daftar
          </Link>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Link href={link({ date: addDays(date, week ? -7 : -1) })} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          ← Sebelumnya
        </Link>
        <span className="text-sm text-muted-foreground">
          {week ? `${from} – ${addDays(to, -1)}` : date}
        </span>
        <Link href={link({ date: addDays(date, week ? 7 : 1) })} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          Berikutnya →
        </Link>
        {week && staff.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            {staff.map((s) => (
              <Link
                key={s.userId}
                href={link({ staffUserId: s.userId })}
                className={buttonVariants({
                  variant: s.userId === staffUserId ? 'default' : 'outline', size: 'sm',
                })}
              >
                {s.name}
              </Link>
            ))}
          </div>
        )}
      </div>

      {staff.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Belum ada staf di cabang ini, jadi belum ada kalender.
        </p>
      ) : !window ? (
        <p className="text-sm text-muted-foreground">
          Cabang tutup sepanjang rentang ini.
        </p>
      ) : (
        <CalendarGrid
          lanes={lanes}
          blocks={blocks}
          startMin={window.startMin}
          endMin={window.endMin}
        />
      )}
    </div>
  )
}
