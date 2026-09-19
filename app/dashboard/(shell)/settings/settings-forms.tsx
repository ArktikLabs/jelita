'use client'

import { useActionState, useState } from 'react'
import {
  setAutoCloseShiftAction, setBrandingAction, setCurrencyAction, setPointsRuleAction,
  setSlotMinutesAction,
} from './actions'
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
import { HEX_RE, THEMES, accentForeground, type ThemeKey } from '@/lib/theme'

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

/**
 * Logo, theme preset and accent colour. Multipart because a file cannot ride
 * in a normal action payload, so the preset and colour travel in the same
 * form and the same action as the logo.
 */
export function BrandingCard({
  slug, hasLogo, logoVersion, brandColor, theme,
}: {
  slug: string
  hasLogo: boolean
  logoVersion: string
  brandColor: string | null
  theme: ThemeKey
}) {
  const [state, action, pending] = useActionState(setBrandingAction, initial)
  // Controlled so the colour well, the hex box and the reset button agree.
  const [accent, setAccent] = useState(brandColor ?? '')
  const [preset, setPreset] = useState<ThemeKey>(theme)
  // Only a complete #rrggbb drives the preview: a half-typed value would feed
  // NaN into accentForeground and snap the colour well to black mid-keystroke.
  // The server re-validates on submit regardless.
  const previewAccent = HEX_RE.test(accent) ? accent : THEMES.find((t) => t.key === preset)!.accent

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tampilan</CardTitle>
        <CardDescription>
          Logo, tema dan warna aksen yang dipakai di dasbor, struk dan halaman pemesanan.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="space-y-5">
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          {state.done && (
            <Alert><AlertDescription>Tampilan disimpan.</AlertDescription></Alert>
          )}

          {hasLogo && (
            // eslint-disable-next-line @next/next/no-img-element -- served
            // from object storage through our own route; next/image would add
            // an optimiser in front of a 50 KB file for nothing.
            <img
              src={`/api/salon/logo?salon=${slug}&v=${logoVersion}`}
              alt="Logo salon"
              className="h-12 w-auto"
            />
          )}
          <div className="space-y-2">
            <Label htmlFor="logo">Logo</Label>
            <input
              id="logo"
              name="logo"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="block text-sm"
            />
            <p className="text-xs text-muted-foreground">PNG, JPEG atau WebP. Maksimal 200 KB.</p>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Tema</legend>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {THEMES.map((t) => {
                const surface = t.mode === 'dark' ? '#252525' : '#ffffff'
                const side = t.mode === 'dark' ? '#343434' : '#f4f4f5'
                const text = t.mode === 'dark' ? '#e5e5e5' : '#3f3f46'
                const swatchAccent = t.key === preset ? previewAccent : t.accent
                return (
                  <label
                    key={t.key}
                    className="cursor-pointer rounded-lg border p-2 has-checked:border-primary has-checked:ring-2 has-checked:ring-primary/30 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2"
                  >
                    <input
                      type="radio"
                      name="theme"
                      value={t.key}
                      defaultChecked={preset === t.key}
                      onChange={() => setPreset(t.key)}
                      className="sr-only"
                    />
                    {/* A miniature of the shell: sidebar strip, a heading line
                        and one accent button. Enough to tell presets apart. */}
                    <div
                      aria-hidden
                      className="flex h-16 overflow-hidden rounded-md border"
                      style={{ background: surface, borderColor: side }}
                    >
                      <div className="w-1/3" style={{ background: side }} />
                      <div className="flex flex-1 flex-col gap-1.5 p-2">
                        <div className="h-1.5 w-3/4 rounded" style={{ background: text, opacity: 0.5 }} />
                        <div className="h-1.5 w-1/2 rounded" style={{ background: text, opacity: 0.3 }} />
                        <div
                          className="mt-auto h-4 w-10 rounded"
                          style={{ background: swatchAccent, color: accentForeground(swatchAccent) }}
                        />
                      </div>
                    </div>
                    <div className="mt-1.5 text-center text-xs">{t.label}</div>
                  </label>
                )
              })}
            </div>
          </fieldset>

          <div className="space-y-2">
            <Label htmlFor="brandColor">Warna aksen</Label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                aria-label="Pilih warna aksen"
                value={accent || previewAccent}
                onChange={(e) => setAccent(e.target.value)}
                className="h-9 w-12 cursor-pointer rounded-md border bg-transparent p-1"
              />
              <input
                id="brandColor"
                name="brandColor"
                value={accent}
                onChange={(e) => setAccent(e.target.value)}
                placeholder={previewAccent}
                className="flex h-9 w-32 rounded-md border bg-transparent px-3 py-1 font-mono text-sm shadow-xs"
              />
              <Button type="button" variant="ghost" size="sm" onClick={() => setAccent('')} disabled={!accent}>
                Pakai warna tema
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Kosongkan untuk memakai warna bawaan tema. Warna ini juga dipakai di struk dan halaman pemesanan.
            </p>
          </div>

          <Button type="submit" variant="outline" disabled={pending}>
            {pending ? 'Menyimpan…' : 'Simpan tampilan'}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

/**
 * PRD has no shift concept; this exists because voiding is bounded by one
 * (POS spec §2.7). Manual by default -- see setAutoCloseShiftAction.
 */
export function ShiftCard({ autoCloseShift }: { autoCloseShift: boolean }) {
  const [state, action, pending] = useActionState(setAutoCloseShiftAction, initial)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Shift kasir</CardTitle>
        <CardDescription>
          Transaksi bisa dibatalkan selama shift-nya masih terbuka. Menutup shift
          mengunci pemasukannya.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="space-y-3">
          {state.error && (
            <Alert variant="destructive"><AlertDescription>{state.error}</AlertDescription></Alert>
          )}
          {state.done && (
            <Alert><AlertDescription>Pengaturan shift disimpan.</AlertDescription></Alert>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input
              id="autoCloseShift"
              type="checkbox"
              name="autoCloseShift"
              value="1"
              defaultChecked={autoCloseShift}
            />
            Tutup shift kemarin otomatis saat transaksi pertama hari ini
          </label>
          <p className="text-xs text-muted-foreground">
            Kalau dimatikan, shift hanya tertutup saat ditutup manual — dan transaksi
            kemarin masih bisa dibatalkan.
          </p>
          <Button type="submit" variant="outline" disabled={pending}>
            {pending ? 'Menyimpan…' : 'Simpan pengaturan shift'}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

/**
 * PRD §5.7's points rule, in either shape. Empty turns it off -- null is "we
 * do not do this", which is a different statement from a zero balance.
 */
export function PointsCard({
  pointsKind, pointsValue,
}: {
  pointsKind: string | null
  pointsValue: string
}) {
  const [state, action, pending] = useActionState(setPointsRuleAction, initial)
  const [kind, setKind] = useState(pointsKind ?? 'spend')

  return (
    <Card>
      <CardHeader>
        <CardTitle>Poin pelanggan</CardTitle>
        <CardDescription>
          Pilih cara menghitung poin, atau kosongkan nilainya kalau salon tidak
          memakai poin.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="space-y-3">
          {state.error && (
            <Alert variant="destructive"><AlertDescription>{state.error}</AlertDescription></Alert>
          )}
          {state.done && (
            <Alert><AlertDescription>Aturan poin disimpan.</AlertDescription></Alert>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="pointsKind">Cara menghitung</Label>
              <select
                id="pointsKind"
                name="pointsKind"
                value={kind}
                onChange={(e) => setKind(e.target.value)}
                className="flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs"
              >
                <option value="spend">Per belanja</option>
                <option value="visit">Per transaksi</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="pointsValue">
                {kind === 'spend' ? 'Belanja per 1 poin' : 'Poin per transaksi'}
              </Label>
              <input
                id="pointsValue"
                name="pointsValue"
                defaultValue={pointsValue}
                placeholder={kind === 'spend' ? '10.000' : '5'}
                className="flex h-9 rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs"
              />
            </div>
          </div>
          <Button type="submit" variant="outline" disabled={pending}>
            {pending ? 'Menyimpan…' : 'Simpan aturan poin'}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
