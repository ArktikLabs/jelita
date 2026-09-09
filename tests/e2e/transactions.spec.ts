import { expect, test } from '@playwright/test'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from '../db'
import { createSalon } from './fixtures'

/**
 * Task 4 (spec §5): the receipt's audit line. "Dicatat oleh" names the
 * cashier on a normal sale; "Dibatalkan oleh" names who voided it on the
 * REVERSAL row voidSale writes (migration 0035: a reversal's own
 * created_by is who voided the original, not the original cashier).
 *
 * Everything else about checkout, voiding and the ledger already lives in
 * tests/pos.spec.ts and tests/pos.db.test.ts -- this file exists only to
 * prove the receipt actually RENDERS the actor's name, which those two
 * never assert.
 */
const DOMAIN = 'txnauditcheck.local'
const PW = 'demo12345'

const pool = new Pool({ connectionString: TEST_DATABASE_URL })

let orgId: string
let serviceId: string
let owner: Awaited<ReturnType<typeof createSalon>>['ctx']

const ownerCookies = async () => (await owner.storageState()).cookies

const todayIso = () => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

test.beforeAll(async () => {
  await pool.query(`delete from organizations where slug like 'txnauditcheck%'`)
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`])

  const salon = await createSalon(pool, {
    name: 'Txn Audit Owner', email: `owner@${DOMAIN}`, password: PW,
    salon: 'Txn Audit Check', slug: 'txnauditcheck',
  })
  owner = salon.ctx
  orgId = salon.organizationId

  serviceId = crypto.randomUUID()
  await pool.query(
    `insert into services (id, organization_id, name, duration_minutes, price)
     values ($1, $2, 'Creambath', 60, 150000)`, [serviceId, orgId])
})

test.afterAll(async () => {
  await pool.query(`truncate transaction_payments, transaction_lines, transactions cascade`)
  await pool.query(`delete from organizations where slug like 'txnauditcheck%'`)
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`])
  await pool.end()
})

test.beforeEach(async () => {
  await pool.query(`truncate transaction_payments, transaction_lines, transactions cascade`)
  await pool.query(`delete from shifts where organization_id = $1`, [orgId])
  await pool.query(`update salon_profiles set next_invoice_no = 1 where organization_id = $1`, [orgId])
})

test('the receipt names the cashier who rang it up', async ({ page }) => {
  await page.context().addCookies(await ownerCookies())
  await page.goto('/dashboard/pos')
  await page.locator('#add').selectOption(serviceId)
  await page.getByRole('button', { name: 'Selesaikan pembayaran' }).click()
  await page.waitForURL('**/dashboard/transactions/**')

  await expect(page.getByText('Dicatat oleh Txn Audit Owner')).toBeVisible()
  await expect(page.getByText('Dibatalkan oleh')).toHaveCount(0)
})

test("a voided sale's reversal names who voided it -- the original's own line still names the cashier", async ({ page }) => {
  await page.context().addCookies(await ownerCookies())
  await page.goto('/dashboard/pos')
  await page.locator('#add').selectOption(serviceId)
  await page.getByRole('button', { name: 'Selesaikan pembayaran' }).click()
  await page.waitForURL('**/dashboard/transactions/**')
  const saleId = page.url().split('/').pop()!

  await page.goto(`/dashboard/transactions?date=${todayIso()}`)
  await page.getByRole('button', { name: 'Batalkan' }).click()
  await expect(page.getByText('Pembatalan')).toBeVisible()

  const { rows: [reversal] } = await pool.query(
    `select id from transactions where reverses_id = $1`, [saleId])

  // The one thing this task added that the receipt did not already say:
  // WHO cancelled it, on the reversal's own page.
  await page.goto(`/dashboard/transactions/${reversal.id}`)
  await expect(page.getByText('Dibatalkan oleh Txn Audit Owner')).toBeVisible()

  // created_by on the ORIGINAL sale never changes when it is voided -- it
  // must still name the cashier, not whoever clicked "Batalkan".
  await page.goto(`/dashboard/transactions/${saleId}`)
  await expect(page.getByText('Dicatat oleh Txn Audit Owner')).toBeVisible()
})
