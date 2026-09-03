import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from './db'
import {
  addDeduction, closePayrollMonth, listDeductions, payrollRecap, payrollRun,
  removeDeduction, setBaseSalary,
} from '../lib/payroll'
import { checkout, voidSale } from '../lib/pos'

/**
 * PRD §5.9's recap, against real Postgres.
 *
 * The commission half comes from the same immutable records the recap in
 * lib/commission.ts reads, so these assertions are about the arithmetic
 * either side of it and about which month a figure belongs to.
 */
const pool = new Pool({ connectionString: TEST_DATABASE_URL })

const ORG = 'pay_org'
const ORG2 = 'pay_org2'
const TEAM = 'pay_team'
const TEAM2 = 'pay_team2'
const SINTA = 'pay_sinta'
const RINA = 'pay_rina'
const OUTSIDER = 'pay_outsider'
const CUSTOMER = 'pay_customer'
const SERVICE = 'pay_service'

const MONTH = '2027-09-01'
const NEXT = '2027-10-01'

const recap = async (month = MONTH, org = ORG) => {
  const rows = await payrollRecap(org, month)
  return Object.fromEntries(rows.map((r) => [r.userId, r]))
}

beforeAll(async () => {
  await pool.query(`delete from organizations where id = any($1)`, [[ORG, ORG2]])
  await pool.query(`
    insert into organizations (id, name, slug, created_at)
    values ($1, 'Pay', 'pay-one', now()), ($2, 'Pay Two', 'pay-two', now())`, [ORG, ORG2])

  // Every organization has an owner, because in production every one does:
  // onboarding creates the salon and the creator's owner membership together.
  // A fixture without one is a state the product cannot reach, and since
  // migration 0025 the database says so -- deactivating anybody in an
  // ownerless salon is refused as "would be left with no active owner".
  for (const [org, id] of [[ORG, 'pay_fixture_owner'], [ORG2, 'pay_fixture_owner2']] as const) {
    await pool.query(`
      insert into users (id, name, email, email_verified, created_at, updated_at)
      values ($1, $1, $1 || '@fixture.local', true, now(), now())
      on conflict (id) do nothing`, [id])
    await pool.query(`
      insert into members (id, user_id, organization_id, role, created_at)
      values ($1 || '_owner_m', $1, $2, 'owner', now())`, [id, org])
  }
  await pool.query(`
    insert into teams (id, name, organization_id, created_at)
    values ($1, 'Cabang Pay', $2, now()), ($3, 'Cabang Pay2', $4, now())`,
    [TEAM, ORG, TEAM2, ORG2])
  for (const [id, org, team] of [
    [SINTA, ORG, TEAM], [RINA, ORG, TEAM], [OUTSIDER, ORG2, TEAM2],
  ] as const) {
    await pool.query(`
      insert into users (id, name, email, email_verified, created_at, updated_at)
      values ($1, $1, $1 || '@pay.local', true, now(), now())`, [id])
    await pool.query(`
      insert into members (id, user_id, organization_id, role, created_at)
      values ($1 || '_m', $1, $2, 'stylist', now())`, [id, org])
    await pool.query(`update staff_profiles set team_id = $1
                       where user_id = $2 and organization_id = $3`, [team, id, org])
  }
  await pool.query(
    `insert into customers (id, organization_id, name) values ($1, $2, 'Pelanggan')`,
    [CUSTOMER, ORG])
  await pool.query(
    `insert into services (id, organization_id, name, duration_minutes, price)
     values ($1, $2, 'Potong', 60, 200000)`, [SERVICE, ORG])
  await pool.query(
    `insert into service_staff (service_id, user_id, organization_id)
     values ($1, $2, $3), ($1, $4, $3)`, [SERVICE, SINTA, ORG, RINA])
  await pool.query(
    `update salon_profiles set commission_kind = 'percent', commission_value = 1000
      where organization_id = $1`, [ORG])
})

afterAll(async () => {
  await pool.query(`truncate transaction_payments, transaction_lines, transactions cascade`)
  await pool.query(`delete from organizations where id = any($1)`, [[ORG, ORG2]])
  await pool.query(`delete from users where id = any($1)`, [[SINTA, RINA, OUTSIDER]])
  await pool.end()
})

beforeEach(async () => {
  await pool.query(`truncate transaction_payments, transaction_lines, transactions cascade`)
  await pool.query(`delete from shifts where organization_id = $1`, [ORG])
  // TRUNCATE, not DELETE: a closed month cannot be reopened, and that trigger
  // is exactly what a teardown needs to bypass. TRUNCATE fires statement-level
  // triggers only. Disabling the trigger by name would work too, and did --
  // until a break that REMOVED the trigger made this teardown error, failing
  // all 22 tests instead of the one that was about reopening.
  //
  // Runs before deductions, because deleting a deduction for a closed month is
  // refused too.
  await pool.query(`truncate payroll_run_lines, payroll_runs cascade`)
  await pool.query(`delete from payroll_deductions where organization_id = $1`, [ORG])
  await pool.query(`update staff_profiles set base_salary = null
                     where organization_id = $1`, [ORG])
})

/** One 200.000 sale at 10% -- 20.000 of commission. */
const sell = (staffUserId: string, completedAt: string) => checkout({
  organizationId: ORG, teamId: TEAM, userId: staffUserId, method: 'cash',
  items: [{ serviceId: SERVICE, quantity: 1, discount: 0, staffUserId }],
  customerId: CUSTOMER, completedAt,
})

describe('the recap', () => {
  it('is base + commission - deductions', async () => {
    await setBaseSalary(SINTA, ORG, 3000000)
    await sell(SINTA, '2027-09-05 10:00')
    await sell(SINTA, '2027-09-06 10:00')
    await addDeduction({
      organizationId: ORG, userId: SINTA, month: MONTH, amount: 150000,
      note: 'Seragam', actorUserId: SINTA,
    })
    const r = (await recap())[SINTA]
    expect(r).toMatchObject({
      baseSalary: 3000000, commission: 40000, deductions: 150000, net: 2890000,
    })
  })

  it('distinguishes NOT SALARIED from salaried at zero', async () => {
    await setBaseSalary(RINA, ORG, 0)
    const r = await recap()
    // null and 0 must not collapse: an owner who set one by accident should be
    // able to tell which they did.
    expect(r[SINTA].baseSalary).toBeNull()
    expect(r[RINA].baseSalary).toBe(0)
  })

  it('counts commission by the month the sale COMPLETED', async () => {
    await sell(SINTA, '2027-09-30 21:00')
    await sell(SINTA, '2027-10-01 09:00')
    expect((await recap(MONTH))[SINTA].commission).toBe(20000)
    expect((await recap(NEXT))[SINTA].commission).toBe(20000)
  })

  it('books a void into the month it HAPPENS, not the month of the sale', async () => {
    // Written first as "voiding gives the commission back", which failed:
    // September kept its 40.000. That is correct, and worth an assertion of
    // its own -- a reversal is an event now, and reopening a month somebody
    // was already paid for would be worse than leaving the adjustment where
    // it belongs. It also softens spec 2.4: a past month's TOTAL cannot be
    // rewritten by a void, only by editing a deduction.
    const { id } = await sell(SINTA, '2027-09-05 10:00')
    await sell(SINTA, '2027-09-06 10:00')
    await voidSale(id, ORG, SINTA)

    expect((await recap(MONTH))[SINTA].commission, 'September is untouched').toBe(40000)

    const now = new Date()
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
    expect((await recap(thisMonth))[SINTA].commission, 'the reversal lands here')
      .toBe(-20000)
  })

  it('does not subtract another month\'s deductions', async () => {
    await addDeduction({
      organizationId: ORG, userId: SINTA, month: NEXT, amount: 500000,
      actorUserId: SINTA,
    })
    expect((await recap(MONTH))[SINTA].deductions).toBe(0)
    expect((await recap(NEXT))[SINTA].deductions).toBe(500000)
  })

  it('adds up several deductions in one month', async () => {
    for (const [amount, note] of [[50000, 'Seragam'], [75000, 'Produk']] as const) {
      await addDeduction({
        organizationId: ORG, userId: SINTA, month: MONTH, amount, note, actorUserId: SINTA,
      })
    }
    expect((await recap())[SINTA].deductions).toBe(125000)
    expect(await listDeductions(ORG, MONTH)).toHaveLength(2)
  })

  it('pins a month to its first day, so the 15th means that month', async () => {
    await addDeduction({
      organizationId: ORG, userId: SINTA, month: '2027-09-15', amount: 10000,
      actorUserId: SINTA,
    })
    expect((await recap(MONTH))[SINTA].deductions).toBe(10000)
  })

  it('never shows another salon\'s staff', async () => {
    const r = await recap()
    // Named rather than an exact set: the fixture salon also has an owner, as
    // every real one does, and asserting the whole roster would break the next
    // time anybody is added for an unrelated reason.
    expect(r[SINTA]).toBeDefined()
    expect(r[RINA]).toBeDefined()
    expect(r[OUTSIDER], 'the other salon\'s stylist').toBeUndefined()
  })

  it('leaves out deactivated staff', async () => {
    await pool.query(`update staff_profiles set active = false
                       where user_id = $1 and organization_id = $2`, [RINA, ORG])
    const r = await recap()
    expect(r[RINA], 'someone who has left is not on the payroll').toBeUndefined()
    expect(r[SINTA], 'and everyone else still is').toBeDefined()
    await pool.query(`update staff_profiles set active = true
                       where user_id = $1 and organization_id = $2`, [RINA, ORG])
  })
})

describe('what the database refuses', () => {
  it('refuses a deduction of zero or less', async () => {
    for (const amount of [0, -1]) {
      await expect(addDeduction({
        organizationId: ORG, userId: SINTA, month: MONTH, amount, actorUserId: SINTA,
      }), String(amount)).rejects.toThrow('BAD_AMOUNT')
    }
  })

  it('refuses a month that is not the first', async () => {
    await expect(pool.query(
      `insert into payroll_deductions (id, organization_id, user_id, month, amount)
       values ($1, $2, $3, '2027-09-15'::date, 1000)`,
      [crypto.randomUUID(), ORG, SINTA]))
      .rejects.toThrow(/payroll_deductions_month_start/)
  })

  it('refuses a negative base salary', async () => {
    await expect(setBaseSalary(SINTA, ORG, -1)).rejects.toThrow('BAD_AMOUNT')
  })

  it('refuses another salon\'s staff', async () => {
    await expect(addDeduction({
      organizationId: ORG, userId: OUTSIDER, month: MONTH, amount: 1000, actorUserId: SINTA,
    })).rejects.toThrow('NOT_FOUND')
    await expect(setBaseSalary(OUTSIDER, ORG, 100)).rejects.toThrow('NOT_FOUND')
  })

  it('cannot remove another salon\'s deduction', async () => {
    await addDeduction({
      organizationId: ORG, userId: SINTA, month: MONTH, amount: 1000, actorUserId: SINTA,
    })
    const [d] = await listDeductions(ORG, MONTH)
    await expect(removeDeduction(d.id, ORG2)).rejects.toThrow('NOT_FOUND')
    await removeDeduction(d.id, ORG)
    expect(await listDeductions(ORG, MONTH)).toEqual([])
  })
})

describe('closing a month', () => {
  const close = () => closePayrollMonth(ORG, MONTH, SINTA)

  it('snapshots exactly what the screen showed', async () => {
    await setBaseSalary(SINTA, ORG, 3000000)
    await sell(SINTA, '2027-09-05 10:00')
    await addDeduction({
      organizationId: ORG, userId: SINTA, month: MONTH, amount: 150000, actorUserId: SINTA,
    })
    const before = (await recap())[SINTA]
    await close()

    const after = (await recap())[SINTA]
    expect(after).toMatchObject({
      baseSalary: before.baseSalary,
      commission: before.commission,
      deductions: before.deductions,
      net: before.net,
    })
    expect(await payrollRun(ORG, MONTH)).not.toBeNull()
  })

  it('stops later changes from rewriting it', async () => {
    await setBaseSalary(SINTA, ORG, 3000000)
    await sell(SINTA, '2027-09-05 10:00')
    await close()

    // Everything that could have moved the number, moved.
    await setBaseSalary(SINTA, ORG, 9000000)
    await sell(SINTA, '2027-09-20 10:00')

    expect((await recap())[SINTA]).toMatchObject({
      baseSalary: 3000000, commission: 20000, net: 3020000,
    })
  })

  it('keeps "not salaried" distinct from zero in the snapshot too', async () => {
    await setBaseSalary(RINA, ORG, 0)
    await close()
    const r = await recap()
    expect(r[SINTA].baseSalary).toBeNull()
    expect(r[RINA].baseSalary).toBe(0)
  })

  it('refuses a deduction for a closed month, added or removed', async () => {
    await addDeduction({
      organizationId: ORG, userId: SINTA, month: MONTH, amount: 50000, actorUserId: SINTA,
    })
    const [existing] = await listDeductions(ORG, MONTH)
    await close()

    await expect(addDeduction({
      organizationId: ORG, userId: SINTA, month: MONTH, amount: 1000, actorUserId: SINTA,
    })).rejects.toThrow('MONTH_CLOSED')
    await expect(removeDeduction(existing.id, ORG)).rejects.toThrow('MONTH_CLOSED')
    // The list still matches the payslip, which is why the trigger exists even
    // though the recap reads a snapshot.
    expect(await listDeductions(ORG, MONTH)).toHaveLength(1)
  })

  it('leaves the NEXT month open, which is where a correction goes', async () => {
    await close()
    await expect(addDeduction({
      organizationId: ORG, userId: SINTA, month: NEXT, amount: 25000,
      note: 'Koreksi September', actorUserId: SINTA,
    })).resolves.toBeUndefined()
    expect((await recap(NEXT))[SINTA].deductions).toBe(25000)
  })

  it('refuses closing the same month twice', async () => {
    await close()
    await expect(close()).rejects.toThrow('ALREADY_CLOSED')
  })

  it('does not block deleting the salon itself', async () => {
    // The carve-out: a cascade must not be refused by a rule about the rows it
    // is cascading into. Without it this suite's own afterAll fails.
    await pool.query(`
      insert into organizations (id, name, slug, created_at)
      values ('pay_temp', 'Temp', 'pay-temp', now())`)
    await pool.query(`
      insert into payroll_runs (id, organization_id, month, closed_by)
      values ('pay_temp_run', 'pay_temp', $1::date, null)`, [MONTH])
    await expect(pool.query(`delete from organizations where id = 'pay_temp'`))
      .resolves.toBeTruthy()
  })

  it('does NOT reopen', async () => {
    await close()
    const run = (await payrollRun(ORG, MONTH))!
    await expect(pool.query(`delete from payroll_runs where id = $1`, [run.id]))
      .rejects.toThrow(/cannot be reopened/)
    await expect(pool.query(
      `update payroll_runs set closed_by = null where id = $1`, [run.id]))
      .rejects.toThrow(/cannot be reopened/)
  })

  it('closes one salon\'s month without touching another\'s', async () => {
    await close()
    expect(await payrollRun(ORG2, MONTH)).toBeNull()
    await expect(addDeduction({
      organizationId: ORG, userId: SINTA, month: MONTH, amount: 1, actorUserId: SINTA,
    })).rejects.toThrow('MONTH_CLOSED')
  })
})
