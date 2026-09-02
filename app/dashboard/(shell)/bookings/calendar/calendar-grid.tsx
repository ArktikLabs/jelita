import Link from 'next/link'

/**
 * The grid itself. A server component: it renders bookings that were already
 * fetched, has no state, and putting it in the client bundle would ship every
 * booking of the day into the RSC payload for nothing.
 *
 * CSS grid, no library. One row per SLOT_ROW minutes, one column per lane
 * (stylists in the day view, days in the week view), and each booking spans
 * the rows its own start and end cover -- which is why a 90-minute service
 * looks twice the height of a 45-minute one without anyone computing pixels.
 */
const SLOT_ROW = 15
const ROW_HEIGHT = 14

export type Lane = { key: string; label: string }

export type Block = {
  id: string
  lane: string
  startMin: number
  endMin: number
  title: string
  subtitle: string
  status: string
}

/** Same palette as the day list's badges, so a status means one thing across
 *  both screens. */
const TONE: Record<string, string> = {
  pending: 'border-muted-foreground/40 bg-muted',
  confirmed: 'border-primary/40 bg-primary/10',
  completed: 'border-primary/40 bg-primary/20',
  cancelled: 'border-destructive/40 bg-destructive/10 line-through opacity-60',
  no_show: 'border-destructive/40 bg-destructive/10 opacity-60',
}

const hhmm = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`

export function CalendarGrid({
  lanes, blocks, startMin, endMin,
}: {
  lanes: Lane[]
  blocks: Block[]
  startMin: number
  endMin: number
}) {
  const rows = Math.ceil((endMin - startMin) / SLOT_ROW)
  // An hour line every hour, from the first whole hour at or after opening.
  const hourMarks: number[] = []
  for (let m = Math.ceil(startMin / 60) * 60; m < endMin; m += 60) hourMarks.push(m)

  const rowOf = (min: number) => Math.round((min - startMin) / SLOT_ROW) + 1

  return (
    // Scrolls inside its own container: a salon with eight stylists must not
    // make the whole page scroll sideways.
    <div className="overflow-x-auto">
      <div className="min-w-fit">
        <div
          className="grid border-b text-xs font-medium"
          style={{ gridTemplateColumns: `4rem repeat(${lanes.length}, minmax(9rem, 1fr))` }}
        >
          <div />
          {lanes.map((l) => (
            <div key={l.key} className="border-l px-2 py-1">{l.label}</div>
          ))}
        </div>

        <div
          className="grid"
          style={{
            gridTemplateColumns: `4rem repeat(${lanes.length}, minmax(9rem, 1fr))`,
            gridTemplateRows: `repeat(${rows}, ${ROW_HEIGHT}px)`,
          }}
        >
          {hourMarks.map((m) => (
            <div
              key={m}
              className="border-t pr-2 text-right text-xs text-muted-foreground"
              style={{ gridColumn: 1, gridRow: `${rowOf(m)} / span ${60 / SLOT_ROW}` }}
            >
              {hhmm(m)}
            </div>
          ))}
          {lanes.map((l, i) =>
            hourMarks.map((m) => (
              <div
                key={`${l.key}-${m}`}
                className="border-l border-t"
                style={{ gridColumn: i + 2, gridRow: `${rowOf(m)} / span ${60 / SLOT_ROW}` }}
              />
            )),
          )}

          {blocks.map((b) => {
            const lane = lanes.findIndex((l) => l.key === b.lane)
            if (lane < 0) return null
            return (
              <Link
                key={b.id}
                href={`/dashboard/bookings/${b.id}`}
                className={`m-px overflow-hidden rounded border px-1 py-0.5 text-xs ${TONE[b.status] ?? TONE.pending}`}
                style={{
                  gridColumn: lane + 2,
                  // Clamped to the grid: a booking that starts before opening
                  // or runs past closing must not silently vanish, which is
                  // what an out-of-range grid-row does.
                  gridRow: `${Math.max(1, rowOf(b.startMin))} / ${Math.min(rows + 1, rowOf(b.endMin))}`,
                }}
              >
                <div className="truncate font-medium">{hhmm(b.startMin)} {b.title}</div>
                <div className="truncate text-muted-foreground">{b.subtitle}</div>
              </Link>
            )
          })}
        </div>
      </div>
    </div>
  )
}
