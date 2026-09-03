import { expect, test } from '@playwright/test'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from '../db'
import { BASE_URL, createSalon, signIn } from './fixtures'

/**
 * PRD §5.9's recap through the app: setting a base salary, adding a deduction,
 * and who may see any of it.
 *
 * The arithmetic and the month boundaries live in tests/payroll.db.test.ts --
 * SQL assertions cover those far better than driving a form.
 */
const DOMAIN = 'paycheck.local'
const PW = 'demo12345'

const pool = new Pool({ connectionString: TEST_DATABASE_URL })

let orgId: string
let teamId: string
let stylistId: string
let owner: Awaited<ReturnType<typeof createSalon>>['ctx']
let desk: Awaited<ReturnType<typeof signIn>>
let stylistCtx: Awaited<ReturnType<typeof signIn>>

const ownerCookies = async () => (await owner.storageState()).cookies
const month = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

test.beforeAll(async () => {
  await pool.query(`delete from organizations where slug like 'paycheck%'`)
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`])

  const salon = await createSalon(pool, {
    name: 'Pay Owner', email: `owner@${DOMAIN}`, password: PW,
    salon: 'Pay Check', slug: 'paycheck',
  })
  owner = salon.ctx
  orgId = salon.organizationId
  const { rows: [team] } = await pool.query(
    `select id from teams where organization_id = $1 order by created_at limit 1`, [orgId])
  teamId = team.id

  const made = await owner.post('/api/staff', {
    data: {
      name: 'Pay Stylist', email: `stylist@${DOMAIN}`, password: PW,
      role: 'stylist', branchId: teamId,
    },
  })
  stylistId = (await made.json()).user.id
  await owner.post('/api/staff', {
    data: {
      name: 'Pay Desk', email: `desk@${DOMAIN}`, password: PW,
      role: 'frontdesk', branchId: teamId,
    },
  })
  desk = await signIn(`desk@${DOMAIN}`, PW)
  stylistCtx = await signIn(`stylist@${DOMAIN}`, PW)
})

test.afterAll(async () => {
  await pool.query(`delete from organizations where slug like 'paycheck%'`)
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`])
  await pool.end()
})

test.beforeEach(async () => {
  await pool.query(`delete from payroll_deductions where organization_id = $1`, [orgId])
  await pool.query(`update staff_profiles set base_salary = null
                     where organization_id = $1`, [orgId])
})

test.describe.serial('the payroll recap', () => {
  test('a base salary set on the staff page shows in the recap', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto(`/dashboard/staff/${stylistId}`)
    await page.locator('#baseSalary').fill('3.000.000')
    await page.getByRole('button', { name: 'Simpan gaji pokok' }).click()
    await expect(page.getByText('Gaji pokok disimpan.')).toBeVisible()

    await page.goto(`/dashboard/payroll?month=${month()}`)
    await expect(page.getByTestId(`base-${stylistId}`)).toContainText('3.000.000')
    await expect(page.getByTestId(`net-${stylistId}`)).toContainText('3.000.000')
  })

  test('an empty base salary means NOT SALARIED, shown as a dash', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto(`/dashboard/staff/${stylistId}`)
    await page.locator('#baseSalary').fill('3.000.000')
    await page.getByRole('button', { name: 'Simpan gaji pokok' }).click()
    await expect(page.getByText('Gaji pokok disimpan.')).toBeVisible()

    await page.goto(`/dashboard/staff/${stylistId}`)
    await page.locator('#baseSalary').fill('')
    await page.getByRole('button', { name: 'Simpan gaji pokok' }).click()
    await expect(page.getByText('Gaji pokok disimpan.')).toBeVisible()

    await page.goto(`/dashboard/payroll?month=${month()}`)
    // A dash, not Rp 0 -- clearing the field says "not salaried", which is a
    // different statement from "salaried at nothing".
    await expect(page.getByTestId(`base-${stylistId}`)).toHaveText('—')
    const { rows } = await pool.query(
      `select base_salary from staff_profiles where user_id = $1`, [stylistId])
    expect(rows[0].base_salary).toBeNull()
  })

  test('a deduction lowers the net, and removing it restores', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto(`/dashboard/staff/${stylistId}`)
    await page.locator('#baseSalary').fill('3.000.000')
    await page.getByRole('button', { name: 'Simpan gaji pokok' }).click()
    await expect(page.getByText('Gaji pokok disimpan.')).toBeVisible()

    await page.goto(`/dashboard/payroll?month=${month()}`)
    await page.locator('#userId').selectOption(stylistId)
    await page.locator('#amount').fill('150.000')
    await page.locator('#note').fill('Seragam')
    await page.getByRole('button', { name: 'Tambah potongan' }).click()
    await expect(page.getByText('Potongan disimpan.')).toBeVisible()
    await expect(page.getByTestId(`net-${stylistId}`)).toContainText('2.850.000')

    await page.getByRole('button', { name: 'Hapus' }).click()
    await expect(page.getByTestId(`net-${stylistId}`)).toContainText('3.000.000')
  })

  test('refuses a deduction that is not a number', async ({ page }) => {
    await page.context().addCookies(await ownerCookies())
    await page.goto(`/dashboard/payroll?month=${month()}`)
    await page.locator('#userId').selectOption(stylistId)
    await page.locator('#amount').fill('banyak')
    await page.getByRole('button', { name: 'Tambah potongan' }).click()
    await expect(page.getByText('Jumlah tidak valid.')).toBeVisible()
  })
})

test.describe('who may see pay', () => {
  test('front desk and stylists are refused the page entirely', async () => {
    for (const [who, ctx] of [['front desk', desk], ['stylist', stylistCtx]] as const) {
      const res = await ctx.get('/dashboard/payroll')
      expect(res.headers()['location'] ?? '', `${who} holds no payroll statement`)
        .toContain('/dashboard')
    }
  })

  test('and never see the base salary card on a staff page', async () => {
    const html = await (await desk.get(`/dashboard/staff/${stylistId}`)).text()
    // Front desk cannot reach /dashboard/staff at all, so this is belt and
    // braces -- the card is gated on payroll:['read'], not on reaching the page.
    expect(html).not.toContain('Gaji pokok per bulan')
  })

  test('the nav shows payroll to the owner and to nobody else', async () => {
    expect(await (await owner.get('/dashboard')).text()).toContain('/dashboard/payroll')
    expect(await (await stylistCtx.get('/dashboard')).text()).not.toContain('/dashboard/payroll')
  })
})
