'use client'

import { useActionState, useState } from 'react'
import { adjustStockAction, createProductAction } from './actions'
import type { FormState } from '@/lib/form-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card'

const initial: FormState = {}
const inputClass = 'flex h-9 rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs'

export function ProductCreateForm() {
  const [state, action, pending] = useActionState(createProductAction, initial)
  const [kind, setKind] = useState('retail')

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tambah produk</CardTitle>
        <CardDescription>
          Ritel dijual di kasir dan stoknya berkurang otomatis. Pemakaian internal
          hanya dicatat lewat penyesuaian stok.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="space-y-4">
          {state.error && (
            <Alert variant="destructive"><AlertDescription>{state.error}</AlertDescription></Alert>
          )}
          {state.done && (
            <Alert><AlertDescription>Produk ditambahkan.</AlertDescription></Alert>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="name">Nama</Label>
              <Input id="name" name="name" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sku">SKU</Label>
              <Input id="sku" name="sku" placeholder="opsional" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="kind">Jenis</Label>
              <select
                id="kind" name="kind" value={kind}
                onChange={(e) => setKind(e.target.value)}
                className={`${inputClass} w-full`}
              >
                <option value="retail">Ritel</option>
                <option value="internal">Pemakaian internal</option>
              </select>
            </div>
            {/* Only retail has a price -- an internal item is never sold, so a
                price on it is a number nobody ever charges. */}
            {kind === 'retail' && (
              <div className="space-y-2">
                <Label htmlFor="price">Harga</Label>
                <Input id="price" name="price" required />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="reorderLevel">Batas stok minimum</Label>
              <Input id="reorderLevel" name="reorderLevel" type="number" min={0} defaultValue={0} />
            </div>
          </div>
          <Button type="submit" disabled={pending}>
            {pending ? 'Menyimpan…' : 'Tambah produk'}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

/** A movement, never an edit: the ledger is append-only, so a miscount is
 *  corrected by another row. */
export function StockAdjustForm({
  products,
}: {
  products: { id: string; name: string }[]
}) {
  const [state, action, pending] = useActionState(adjustStockAction, initial)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Catat stok</CardTitle>
        <CardDescription>
          Masuk pakai angka positif, keluar pakai negatif. Koreksi ditulis sebagai
          catatan baru, bukan dengan mengubah yang lama.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="space-y-4">
          {state.error && (
            <Alert variant="destructive"><AlertDescription>{state.error}</AlertDescription></Alert>
          )}
          {state.done && (
            <Alert><AlertDescription>Stok dicatat.</AlertDescription></Alert>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="productId">Produk</Label>
              <select id="productId" name="productId" required className={`${inputClass} w-full`}>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="reason">Alasan</Label>
              <select id="reason" name="reason" className={`${inputClass} w-full`}>
                <option value="purchase">Pembelian</option>
                <option value="usage">Pemakaian</option>
                <option value="adjustment">Penyesuaian</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="quantity">Jumlah</Label>
              <Input id="quantity" name="quantity" type="number" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="note">Catatan</Label>
              <Input id="note" name="note" placeholder="opsional" />
            </div>
          </div>
          <Button type="submit" variant="outline" disabled={pending}>
            {pending ? 'Menyimpan…' : 'Catat stok'}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
