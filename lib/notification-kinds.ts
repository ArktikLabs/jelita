import type { NotificationKind } from './notify'

/**
 * The label for each event.
 *
 * Its own module because BOTH the server page and the client form need it, and
 * a value exported from a `'use client'` file reaches a server component as a
 * client REFERENCE, not the object -- the lookup then yields undefined and the
 * column renders empty with no error anywhere. Found by screenshotting the
 * page; nothing else caught it.
 *
 * Not in lib/notify.ts either: that module imports node:fs and the database, so
 * a client component cannot pull it in.
 */
export const KIND_LABEL: Record<NotificationKind, string> = {
  booking_confirmed: 'Konfirmasi booking',
  reminder_day_before: 'Pengingat H-1',
  reminder_2h: 'Pengingat 2 jam sebelum',
  thank_you: 'Terima kasih setelah kunjungan',
}
