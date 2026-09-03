import { sql } from 'drizzle-orm'
import { db } from './db'
import { pgCode } from './pg-error'

/**
 * PRD §5.9: "payroll recap = base salary + commission + deductions per staff
 * per month".
 *
 * COMPUTED ON READ, and that is a stated limitation rather than an oversight.
 * Commissions are immutable so that half cannot drift, but a deduction edited
 * after payday silently rewrites a month somebody was already paid for. The
 * fix is a payroll RUN that snapshots and freezes -- which is what
 * payroll:['run','lock'] are reserved for (spec 2.4).
 */

export type PayrollRow = {
  userId: string
  name: string
  role: string
  /** Null means NOT SALARIED, which is different from salaried at zero. */
  baseSalary: number | null
  commission: number
  deductions: number
  net: number
  currency: string
}

export type DeductionRow = {
  id: string
  userId: string
  staffName: string
  amount: number
  note: string | null
  createdAt: string
}

/** `month` is any date; it is pinned to the first here so a caller passing
 *  the 15th gets that month rather than nothing. */
const firstOf = (month: string) => `${month.slice(0, 7)}-01`

export async function payrollRecap(
  organizationId: string, month: string,
): Promise<PayrollRow[]> {
  const start = firstOf(month)
  const { rows } = await db.execute(sql`
    select sp.user_id, u.name, m.role, sp.base_salary,
           coalesce(c.commission, 0)::bigint as commission,
           coalesce(d.deductions, 0)::bigint as deductions,
           coalesce(p.currency, 'IDR') as currency
      from staff_profiles sp
      join users u on u.id = sp.user_id
      join members m on m.user_id = sp.user_id and m.organization_id = sp.organization_id
      join salon_profiles p on p.organization_id = sp.organization_id
      -- Commission for the month the sale COMPLETED, not the month this is
      -- read in: a recap opened in October must still show September's.
      left join (
        select c.staff_user_id, sum(c.amount) as commission
          from commissions c
          join transactions t on t.id = c.transaction_id
         where c.organization_id = ${organizationId}
           and t.completed_at >= ${start}::date
           and t.completed_at < (${start}::date + interval '1 month')
         group by c.staff_user_id
      ) c on c.staff_user_id = sp.user_id
      left join (
        select user_id, sum(amount) as deductions
          from payroll_deductions
         where organization_id = ${organizationId} and month = ${start}::date
         group by user_id
      ) d on d.user_id = sp.user_id
     where sp.organization_id = ${organizationId} and sp.active
     order by u.name, sp.user_id`)

  return (rows as Record<string, unknown>[]).map((r) => {
    const base = r.base_salary === null ? null : Number(r.base_salary)
    const commission = Number(r.commission)
    const deductions = Number(r.deductions)
    return {
      userId: r.user_id as string,
      name: r.name as string,
      role: r.role as string,
      baseSalary: base,
      commission,
      deductions,
      net: (base ?? 0) + commission - deductions,
      currency: r.currency as string,
    }
  })
}

export async function listDeductions(
  organizationId: string, month: string,
): Promise<DeductionRow[]> {
  const { rows } = await db.execute(sql`
    select d.id, d.user_id, u.name as staff_name, d.amount, d.note,
           to_char(d.created_at, 'YYYY-MM-DD') as created_at
      from payroll_deductions d
      join users u on u.id = d.user_id
     where d.organization_id = ${organizationId} and d.month = ${firstOf(month)}::date
     order by u.name, d.created_at`)
  return (rows as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    userId: r.user_id as string,
    staffName: r.staff_name as string,
    amount: Number(r.amount),
    note: (r.note as string) ?? null,
    createdAt: r.created_at as string,
  }))
}

export async function addDeduction(input: {
  organizationId: string
  userId: string
  month: string
  amount: number
  note?: string | null
  actorUserId: string
}): Promise<void> {
  try {
    await db.execute(sql`
      insert into payroll_deductions (id, organization_id, user_id, month, amount,
                                      note, actor_user_id)
      values (${crypto.randomUUID()}, ${input.organizationId}, ${input.userId},
              ${firstOf(input.month)}::date, ${input.amount}, ${input.note ?? null},
              ${input.actorUserId})`)
  } catch (e) {
    // Translated at the boundary: drizzle wraps driver errors, so a caller
    // matching on `.message` would see only "Failed query: ...".
    if (pgCode(e) === '23503') throw new Error('NOT_FOUND')
    if (pgCode(e) === '23514') throw new Error('BAD_AMOUNT')
    throw e
  }
}

/** Removable while the month is open -- which, with no payroll run, is
 *  always. The limitation named in spec 2.4. */
export async function removeDeduction(
  id: string, organizationId: string,
): Promise<void> {
  const { rowCount } = await db.execute(sql`
    delete from payroll_deductions
     where id = ${id} and organization_id = ${organizationId}`)
  if (!rowCount) throw new Error('NOT_FOUND')
}

export async function setBaseSalary(
  userId: string, organizationId: string, baseSalary: number | null,
): Promise<void> {
  let rowCount: number | null
  try {
    ({ rowCount } = await db.execute(sql`
      update staff_profiles set base_salary = ${baseSalary}, updated_at = now()
       where user_id = ${userId} and organization_id = ${organizationId}`))
  } catch (e) {
    // Translated here for the same reason addDeduction does it: drizzle wraps
    // the driver error, so a caller matching on `.message` sees only
    // "Failed query: ...".
    if (pgCode(e) === '23514') throw new Error('BAD_AMOUNT')
    throw e
  }
  if (!rowCount) throw new Error('NOT_FOUND')
}
