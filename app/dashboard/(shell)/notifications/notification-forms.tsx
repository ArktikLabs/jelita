'use client'

import { useActionState } from 'react'
import { processDueAction, setTemplateAction } from './actions'
import type { FormState } from '@/lib/form-state'
import type { NotificationKind } from '@/lib/notify'
import { KIND_LABEL } from '@/lib/notification-kinds'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card'

const initial: FormState = {}

/**
 * The stand-in for a scheduler.
 *
 * Labelled with the count so the button says what it will do, and disabled at
 * zero rather than hidden -- a control that vanishes reads as a broken page,
 * and its absence is exactly the information "nothing is due" carries.
 */
export function ProcessDueButton({ due }: { due: number }) {
  const [state, action, pending] = useActionState(
    async () => processDueAction(), initial)

  return (
    <form action={action} className="flex items-center gap-3">
      {state.done && (
        <span className="text-sm text-muted-foreground">Terkirim.</span>
      )}
      <Button type="submit" disabled={pending || due === 0}>
        {pending ? 'Mengirim…' : `Kirim yang jatuh tempo (${due})`}
      </Button>
    </form>
  )
}

/**
 * One template per event. Separate forms rather than one big save: an owner
 * editing the thank-you should not have to re-submit the other three, and a
 * failure on one must not silently discard the others.
 */
export function TemplateCard({
  templates,
}: {
  templates: { kind: NotificationKind; body: string }[]
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Template pesan</CardTitle>
        <CardDescription>
          Isi yang tersedia: {'{{customer}}'}, {'{{salon}}'}, {'{{branch}}'},{' '}
          {'{{service}}'}, {'{{staff}}'}, {'{{date}}'}, {'{{time}}'}. Pesan yang
          sudah masuk antrean tidak ikut berubah.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {templates.map((t) => (
          <TemplateForm key={t.kind} kind={t.kind} body={t.body} />
        ))}
      </CardContent>
    </Card>
  )
}

function TemplateForm({ kind, body }: { kind: NotificationKind; body: string }) {
  const [state, action, pending] = useActionState(setTemplateAction, initial)

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="kind" value={kind} />
      <Label htmlFor={`tpl-${kind}`}>{KIND_LABEL[kind]}</Label>
      <textarea
        id={`tpl-${kind}`}
        name="body"
        rows={3}
        defaultValue={body}
        className="flex w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs"
      />
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      {state.done && (
        <Alert><AlertDescription>Tersimpan.</AlertDescription></Alert>
      )}
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? 'Menyimpan…' : 'Simpan'}
      </Button>
    </form>
  )
}
