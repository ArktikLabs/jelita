'use server'

import { revalidatePath } from 'next/cache'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { requireBranch, requirePagePermission } from '@/lib/session'
import { recordMovement } from '@/lib/inventory'
import { parseMoney } from '@/lib/money'
import { salonSettings } from '@/lib/service'
import { type FormState } from '@/lib/form-state'

export async function createProductAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  await requirePagePermission({ product: ['create'] })
  const { organizationId } = await requireBranch({ write: true })
  if (!organizationId) return { error: 'Tidak ada salon aktif.' }

  const name = String(formData.get('name') ?? '').trim()
  const kind = String(formData.get('kind') ?? 'retail')
  const sku = String(formData.get('sku') ?? '').trim() || null
  const reorderLevel = Number(formData.get('reorderLevel') ?? 0) || 0
  if (!name) return { error: 'Nama produk wajib diisi.' }
  if (kind !== 'retail' && kind !== 'internal') return { error: 'Jenis tidak dikenali.' }
  if (reorderLevel < 0) return { error: 'Batas stok minimum tidak boleh negatif.' }

  // Internal stock is never sold, so a price on it is a number nobody ever
  // charges -- also a check constraint.
  let price: number | null = null
  if (kind === 'retail') {
    const { currency } = await salonSettings(organizationId)
    price = parseMoney(String(formData.get('price') ?? ''), currency)
    if (price === null) return { error: 'Harga tidak valid.' }
  }

  await db.execute(sql`
    insert into products (id, organization_id, name, sku, kind, price, reorder_level)
    values (${crypto.randomUUID()}, ${organizationId}, ${name}, ${sku}, ${kind},
            ${price}, ${reorderLevel})`)
  revalidatePath('/dashboard/products')
  return { done: true }
}

/**
 * A stock movement, never an edit: the ledger is append-only and a correction
 * is another row (spec 2.2).
 */
export async function adjustStockAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  // stock:['adjust'], not product:['update'] -- the statement already names
  // this separately, and front desk holds stock:['read'] alone.
  const session = await requirePagePermission({ stock: ['adjust'] })
  const { organizationId, branchId } = await requireBranch({ write: true })
  if (!organizationId) return { error: 'Tidak ada salon aktif.' }

  const productId = String(formData.get('productId') ?? '')
  const quantity = Number(formData.get('quantity') ?? 0)
  const reason = String(formData.get('reason') ?? '')
  if (!['purchase', 'usage', 'adjustment'].includes(reason)) {
    // 'sale' is deliberately absent: a sale movement is written by checkout,
    // and one typed in by hand would have no transaction behind it.
    return { error: 'Alasan tidak dikenali.' }
  }
  if (!Number.isInteger(quantity) || quantity === 0) {
    return { error: 'Jumlah harus bilangan bulat selain nol.' }
  }

  try {
    await recordMovement({
      organizationId, teamId: branchId, productId, quantity,
      reason: reason as 'purchase' | 'usage' | 'adjustment',
      actorUserId: session.user.id,
      note: String(formData.get('note') ?? '').trim() || null,
    })
  } catch (e) {
    if (e instanceof Error && e.message === 'NOT_FOUND') {
      return { error: 'Produk tidak ditemukan.' }
    }
    throw e
  }
  revalidatePath('/dashboard/products')
  return { done: true }
}
