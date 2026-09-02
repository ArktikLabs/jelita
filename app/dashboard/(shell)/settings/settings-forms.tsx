'use client'

import { useActionState } from 'react'
import { setCurrencyAction, setSlotMinutesAction } from './actions'
import type { FormState } from '@/lib/form-state'
import { SUPPORTED_CURRENCIES, type CurrencyCode } from '@/lib/money'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'

const initial: FormState = {}

/**
 * While the catalogue is empty this is an editable card; once any service
 * exists (spec 2.6 of the services design) it collapses to a read-only line --
 * switching currency after prices exist would reinterpret every stored
 * minor-unit amount by orders of magnitude, so there is nothing to edit here
 * any more.
 *
 * The one salon-wide setting that LOCKS. Contrast SlotGridCard below, which
 * never does.
 */
export function CurrencyCard({
  currency, hasServices,
}: {
  currency: CurrencyCode
  hasServices: boolean
}) {
  const [state, action, pending] = useActionState(setCurrencyAction, initial)

  if (hasServices) {
    return (
      <p className="text-sm text-muted-foreground">
        Mata uang salon: <span className="font-medium text-foreground">{currency}</span> —
        sudah ada layanan berharga, jadi mata uang tidak bisa diubah lagi.
      </p>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Mata uang salon</CardTitle>
        <CardDescription>
          Bisa diubah selama belum ada layanan berharga. Setelah layanan pertama dibuat,
          mata uang terkunci.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="space-y-2">
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          {state.done && (
            <Alert>
              <AlertDescription>Mata uang disimpan.</AlertDescription>
            </Alert>
          )}
          <div className="flex items-end gap-2">
            <div className="space-y-2">
              <Label htmlFor="currency">Mata uang</Label>
              <Select name="currency" defaultValue={currency}>
                <SelectTrigger id="currency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.keys(SUPPORTED_CURRENCIES).map((code) => (
                    <SelectItem key={code} value={code}>{code}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" variant="outline" disabled={pending}>
              {pending ? 'Menyimpan…' : 'Simpan mata uang'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

const SLOT_CHOICES = [15, 20, 30, 45, 60]

/**
 * The booking grid. Always editable, because a booking stores its own start
 * and end -- changing this changes which slots are offered tomorrow and
 * cannot touch what is already booked (spec 2.3).
 */
export function SlotGridCard({ slotMinutes }: { slotMinutes: number }) {
  const [state, action, pending] = useActionState(setSlotMinutesAction, initial)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Interval jadwal</CardTitle>
        <CardDescription>
          Jarak antar pilihan jam pada halaman pemesanan. Bisa diubah kapan saja —
          janji temu yang sudah ada menyimpan jamnya sendiri dan tidak ikut berubah.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="space-y-2">
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          {state.done && (
            <Alert>
              <AlertDescription>Interval jadwal disimpan.</AlertDescription>
            </Alert>
          )}
          <div className="flex items-end gap-2">
            <div className="space-y-2">
              <Label htmlFor="slotMinutes">Interval</Label>
              <Select name="slotMinutes" defaultValue={String(slotMinutes)}>
                <SelectTrigger id="slotMinutes">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SLOT_CHOICES.map((m) => (
                    <SelectItem key={m} value={String(m)}>{m} menit</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" variant="outline" disabled={pending}>
              {pending ? 'Menyimpan…' : 'Simpan interval'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
