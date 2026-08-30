/**
 * Idempotent tier seed. Prices and caps are business decisions — edit this
 * file and re-run; no migration needed.
 *   pnpm plan:seed
 *
 * PLANS is exported so scripts/plan-check.mjs derives its cap expectations
 * from the same array instead of duplicating the numbers. Importing this file
 * therefore must not seed anything — hence the entry-point guard below.
 */
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'

const FEATURES = [
  ['online_booking', 'Booking online', 'Halaman booking publik untuk pelanggan', 1],
  ['commissions', 'Komisi staf', 'Perhitungan komisi otomatis per transaksi', 2],
  ['whatsapp', 'Notifikasi WhatsApp', 'Konfirmasi dan pengingat via WhatsApp', 3],
  ['inventory', 'Inventori & stok', 'Kartu stok, stok masuk/keluar, alert stok menipis', 4],
  ['report_export', 'Ekspor laporan', 'Unduh laporan ke CSV', 5],
  ['payroll', 'Payroll', 'Rekap gaji bulanan per staf', 6],
]

export const PLANS = [
  { key: 'free', name: 'Free', price: 0, isDefault: true, sort: 1,
    caps: { branches: 1, staff: 3, services: 10, products: 20 },
    features: ['online_booking'] },
  { key: 'starter', name: 'Starter', price: 199000, isDefault: false, sort: 2,
    caps: { branches: 1, staff: 8, services: 50, products: 200 },
    features: ['online_booking', 'commissions', 'whatsapp'] },
  { key: 'pro', name: 'Pro', price: 499000, isDefault: false, sort: 3,
    caps: { branches: 3, staff: 25 },
    features: ['online_booking', 'commissions', 'whatsapp', 'inventory', 'report_export'] },
  { key: 'business', name: 'Business', price: 1499000, isDefault: false, sort: 4,
    caps: {},
    features: ['online_booking', 'commissions', 'whatsapp', 'inventory', 'report_export', 'payroll'] },
]

export const DEFAULT_PLAN_KEY = PLANS.find((p) => p.isDefault).key

async function seed() {
  const pool = new Pool({ connectionString: process.env.DIRECT_URL })
  // One checked-out client, one transaction: caps and features are cleared
  // before they are re-inserted, and a crash in that window would leave a tier
  // with no plan_limits rows at all — which entitlements.ts reads as
  // unlimited, silently uncapping every tenant on it.
  const client = await pool.connect()
  try {
    await client.query('begin')

    for (const [key, label, description, sortOrder] of FEATURES) {
      await client.query(
        `insert into features (key, label, description, sort_order)
         values ($1,$2,$3,$4)
         on conflict (key) do update
           set label = excluded.label,
               description = excluded.description,
               sort_order = excluded.sort_order`,
        [key, label, description, sortOrder])
    }

    for (const p of PLANS) {
      const { rows } = await client.query(
        `insert into plans (key, name, price_idr, is_default, sort_order)
         values ($1,$2,$3,$4,$5)
         on conflict (key) do update
           set name = excluded.name,
               price_idr = excluded.price_idr,
               sort_order = excluded.sort_order
         returning id`,
        [p.key, p.name, p.price, p.isDefault, p.sort])
      const planId = rows[0].id

      await client.query(`delete from plan_limits where plan_id = $1`, [planId])
      for (const [resource, cap] of Object.entries(p.caps)) {
        await client.query(
          `insert into plan_limits (plan_id, resource, cap) values ($1,$2,$3)`,
          [planId, resource, cap])
      }

      await client.query(`delete from plan_features where plan_id = $1`, [planId])
      for (const f of p.features) {
        await client.query(
          `insert into plan_features (plan_id, feature_key) values ($1,$2)`,
          [planId, f])
      }
    }

    // is_default is set separately: the partial unique index refuses two rows
    // with is_default true, so the old default must be cleared first.
    await client.query(`update plans set is_default = false where key <> $1`, [DEFAULT_PLAN_KEY])
    await client.query(`update plans set is_default = true where key = $1`, [DEFAULT_PLAN_KEY])

    await client.query('commit')
  } catch (e) {
    await client.query('rollback')
    throw e
  } finally {
    client.release()
  }

  const { rows: summary } = await pool.query(
    `select p.key, p.price_idr,
            (select count(*) from plan_limits l where l.plan_id = p.id) caps,
            (select count(*) from plan_features f where f.plan_id = p.id) feats
       from plans p order by p.sort_order`)
  console.table(summary)
  await pool.end()
}

// `import.meta.main` only exists on Node >= 24.2; below that it is undefined,
// so the seed would silently do nothing and still exit 0 — the same fail-open
// shape the transaction above exists to prevent. Compare argv instead.
if (process.argv[1] === fileURLToPath(import.meta.url)) await seed()
