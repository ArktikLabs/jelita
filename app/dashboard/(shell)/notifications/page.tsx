import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { requirePageOrg, requirePagePermission } from '@/lib/session'
import { listNotifications, listTemplates } from '@/lib/notify'
import { Badge } from '@/components/ui/badge'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { KIND_LABEL } from '@/lib/notification-kinds'
import { ProcessDueButton, TemplateCard } from './notification-forms'

const STATUS: Record<string, { label: string; variant: 'default' | 'secondary' | 'outline' }> = {
  queued: { label: 'Antre', variant: 'outline' },
  sent: { label: 'Terkirim (simulasi)', variant: 'secondary' },
  cancelled: { label: 'Dibatalkan', variant: 'outline' },
  failed: { label: 'Gagal', variant: 'default' },
}

/**
 * The Notification Center (PRD §5.5).
 *
 * Shows the exact text that would be sent, because that is the demo: the
 * pipeline is real and only the provider is simulated. The body is the stored
 * snapshot, never re-rendered here -- see lib/notify.queueForBooking.
 *
 * Guarded by notification:['read'], which owner, admin and front desk hold and
 * a stylist does not. The template editor below is gated separately on
 * notification:['template:update'], so front desk can work the queue without
 * rewriting what the salon says.
 */
export default async function NotificationsPage() {
  await requirePagePermission({ notification: ['read'] })
  const session = await requirePageOrg()
  const teamId = session.session.activeTeamId ?? null

  const { success: canEditTemplates } = await auth.api.hasPermission({
    headers: await headers(),
    body: { permissions: { notification: ['template:update'] } },
  })

  const [rows, templates] = await Promise.all([
    listNotifications(session.organizationId, teamId),
    canEditTemplates ? listTemplates(session.organizationId) : Promise.resolve([]),
  ])
  const due = rows.filter((r) => r.due).length

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-medium">Notifikasi</h1>
        <ProcessDueButton due={due} />
      </div>

      <p className="text-sm text-muted-foreground">
        Pesan WhatsApp disiapkan saat booking dibuat dan dikirim saat jatuh
        tempo. Pengiriman masih simulasi — menyambungkan provider sungguhan
        hanya soal kredensial, alurnya sudah yang ini.
      </p>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Belum ada pesan.</p>
      ) : (
        <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Jatuh tempo</TableHead>
              <TableHead>Pelanggan</TableHead>
              <TableHead>Jenis</TableHead>
              <TableHead>Pesan</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="whitespace-nowrap align-top text-sm">
                  {r.sentAt ?? r.sendAt}
                  {r.due && (
                    <span className="ml-2 text-xs font-medium text-foreground">jatuh tempo</span>
                  )}
                </TableCell>
                <TableCell className="align-top text-sm">
                  <div>{r.customerName ?? '—'}</div>
                  <div className="text-xs text-muted-foreground">{r.to}</div>
                </TableCell>
                <TableCell className="align-top text-sm">{KIND_LABEL[r.kind]}</TableCell>
                {/* The stored text, verbatim: the whole point is that someone
                    can read what would actually go out.

                    Width on an inner div, not the cell: a table cell treats
                    max-width as a suggestion, so the message ran straight
                    under the status column. */}
                <TableCell className="align-top text-sm">
                  <div className="w-[34rem] max-w-full text-pretty">{r.body}</div>
                </TableCell>
                <TableCell className="align-top">
                  <Badge variant={STATUS[r.status]?.variant ?? 'outline'}>
                    {STATUS[r.status]?.label ?? r.status}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        </div>
      )}

      {canEditTemplates && <TemplateCard templates={templates} />}
    </div>
  )
}
