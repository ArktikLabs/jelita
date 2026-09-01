'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { PlanError, requireQuota } from '@/lib/plan/entitlements'
import { requirePageOrg, requirePagePermission } from '@/lib/session'
import { salonCurrency, listPerformers } from '@/lib/service'
import { listBranches } from '@/lib/branch'
import { parseMoney, isCurrencyCode } from '@/lib/money'
import { formError, type FormState } from '@/lib/form-state'

const NOT_FOUND = { error: 'Layanan tidak ditemukan.' }

/** Scoped by organizationId in the query itself -- every write below must
 *  refuse a foreign or bogus id rather than silently match zero rows. */
async function ownedService(id: string, organizationId: string) {
  const { rows } = await db.execute(sql`
    select 1 from services where id = ${id} and organization_id = ${organizationId} limit 1`)
  return rows.length > 0
}

/** Both the detail form and the overrides/status forms live on this page. */
function revalidateService(id: string) {
  revalidatePath('/services')
  revalidatePath(`/services/${id}`)
}

/**
 * The currency card on /services. Guarded by service:['update'], same as the
 * page itself and every other write in this file -- this is a public POST
 * endpoint in its own right, so the check has to live here too.
 */
export async function setCurrencyAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  await requirePagePermission({ service: ['update'] })
  const { organizationId } = await requirePageOrg()
  const currency = String(formData.get('currency') ?? '')
  if (!isCurrencyCode(currency)) return { error: 'Mata uang tidak dikenali.' }

  // Spec 2.6: switching currency would reinterpret every stored amount by
  // orders of magnitude -- 50000 rupiah silently reading as 50000 dollars.
  // Re-denominating an operating salon is a data migration, not a settings
  // toggle. Checked in the same statement as the write so a service created
  // concurrently cannot slip past a check-then-act gap.
  const { rowCount } = await db.execute(sql`
    update salon_profiles set currency = ${currency}, updated_at = now()
     where organization_id = ${organizationId}
       and not exists (select 1 from services where organization_id = ${organizationId})`)
  if (!rowCount) return { error: 'Mata uang tidak dapat diubah setelah ada layanan berharga.' }
  revalidatePath('/services')
  return { done: true }
}

export async function createServiceAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  await requirePagePermission({ service: ['create'] })
  const { organizationId } = await requirePageOrg()

  const name = String(formData.get('name') ?? '').trim()
  const duration = Number(formData.get('durationMinutes') ?? 0)
  const currency = await salonCurrency(organizationId)
  const price = parseMoney(String(formData.get('price') ?? ''), currency)

  if (!name) return { error: 'Nama layanan wajib diisi.' }
  if (!Number.isInteger(duration) || duration <= 0) {
    return { error: 'Durasi harus lebih dari 0 menit.' }
  }
  if (price === null) return { error: 'Harga tidak valid.' }

  try {
    await requireQuota('services')
    // A categoryId from the client is untrusted, but the composite FK
    // (category_id, organization_id) into service_categories makes a
    // borrowed category unstorable -- see the note in actions.ts's sibling
    // createCategoryAction. Safe only as long as that FK stands.
    const categoryId = String(formData.get('categoryId') ?? '').trim() || null
    await db.execute(sql`
      insert into services (id, organization_id, category_id, name,
                            duration_minutes, price)
      values (${crypto.randomUUID()}, ${organizationId}, ${categoryId},
              ${name}, ${duration}, ${price})`)
  } catch (e) {
    if (e instanceof PlanError) {
      return { error: 'Kuota layanan paket Anda sudah tercapai. Upgrade untuk menambah layanan.' }
    }
    // The unique index on (organization_id, lower(name)) surfaces as a
    // constraint violation -- map it rather than leaking Postgres text.
    // db.execute wraps the driver's error in a DrizzleQueryError whose own
    // .message is "Failed query: ...", not pg's constraint text; the actual
    // "duplicate key value violates unique constraint ..." lives on .cause.
    const pgMessage = e instanceof Error
      ? `${e.message} ${e.cause instanceof Error ? e.cause.message : ''}`
      : ''
    if (/services_org_name_lower/.test(pgMessage)) {
      return { error: 'Layanan dengan nama ini sudah ada.' }
    }
    return { error: formError(e, 'Gagal menambah layanan.') }
  }
  revalidatePath('/services')
  redirect('/services')
}

/**
 * Same guard shape as createServiceAction -- a category is only ever created
 * alongside adding services, so front desk and stylists (service:['read']
 * only) have no path here either. Name-only; deleting a category is out of
 * scope (the on-delete-set-null FK already leaves its services intact).
 */
export async function createCategoryAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  await requirePagePermission({ service: ['create'] })
  const { organizationId } = await requirePageOrg()

  const name = String(formData.get('name') ?? '').trim()
  if (!name) return { error: 'Nama kategori wajib diisi.' }

  try {
    await db.execute(sql`
      insert into service_categories (id, organization_id, name)
      values (${crypto.randomUUID()}, ${organizationId}, ${name})`)
  } catch (e) {
    return { error: formError(e, 'Gagal menambah kategori.') }
  }
  revalidatePath('/services')
  return { done: true }
}

/** The detail screen's edit form -- same fields and validation as
 *  createServiceAction, plus the ownership check every write here needs. */
export async function updateServiceAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  await requirePagePermission({ service: ['update'] })
  const { organizationId } = await requirePageOrg()
  const id = String(formData.get('id') ?? '')
  if (!id || !(await ownedService(id, organizationId))) return NOT_FOUND

  const name = String(formData.get('name') ?? '').trim()
  const duration = Number(formData.get('durationMinutes') ?? 0)
  const currency = await salonCurrency(organizationId)
  const price = parseMoney(String(formData.get('price') ?? ''), currency)
  const categoryId = String(formData.get('categoryId') ?? '').trim() || null

  if (!name) return { error: 'Nama layanan wajib diisi.' }
  if (!Number.isInteger(duration) || duration <= 0) {
    return { error: 'Durasi harus lebih dari 0 menit.' }
  }
  if (price === null) return { error: 'Harga tidak valid.' }

  try {
    await db.execute(sql`
      update services
         set name = ${name}, category_id = ${categoryId},
             duration_minutes = ${duration}, price = ${price}, updated_at = now()
       where id = ${id} and organization_id = ${organizationId}`)
  } catch (e) {
    // Same duplicate-name constraint as createServiceAction -- see the note
    // there on why db.execute's error text lives on .cause, not .message.
    const pgMessage = e instanceof Error
      ? `${e.message} ${e.cause instanceof Error ? e.cause.message : ''}`
      : ''
    if (/services_org_name_lower/.test(pgMessage)) {
      return { error: 'Layanan dengan nama ini sudah ada.' }
    }
    return { error: formError(e, 'Gagal memperbarui layanan.') }
  }
  revalidateService(id)
  return { done: true }
}

/**
 * Every branch's override in one submit -- the card renders one row per
 * branch inside a single form (same shape as updateBranchHoursAction's one
 * row per weekday). Validated all-or-nothing before any write: a rejected
 * row must not leave earlier branches written while later ones are refused.
 *
 * The team ids this loop writes come from listBranches(organizationId), this
 * org's own branches -- NEVER from a teamId embedded in the submitted field
 * name. A price-<foreignTeamId> field in the POST body is simply never read,
 * so an override naming another salon's branch is refused by construction:
 * there is nothing here that would ever look it up.
 */
export async function setBranchOverrideAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  await requirePagePermission({ service: ['update'] })
  const { organizationId } = await requirePageOrg()
  const serviceId = String(formData.get('serviceId') ?? '')
  if (!serviceId || !(await ownedService(serviceId, organizationId))) return NOT_FOUND

  const currency = await salonCurrency(organizationId)
  const branches = await listBranches(organizationId)

  // Iterating THIS list, not the submitted field names, is the whole guard:
  // a price-<foreignTeamId>/offered-<foreignTeamId> pair a client tacked on
  // is simply never looked up, so it is dropped with no error and no
  // indication to the operator that anything was ignored. That silence is
  // deliberate, not an oversight -- it matches this app's convention of
  // never confirming the existence of another salon's resources (the same
  // reason a foreign service id 404s instead of saying "not yours"). Do not
  // "fix" this into an explicit rejection; that would leak the same fact.
  const rows: { teamId: string; price: number | null; offered: boolean }[] = []
  for (const b of branches) {
    const raw = String(formData.get(`price-${b.teamId}`) ?? '').trim()
    // Empty means INHERITS. A value equal to the salon price is still an
    // override -- collapsing the two would silently stop a salon-wide price
    // change from reaching this branch (spec 2.1).
    const price = raw === '' ? null : parseMoney(raw, currency)
    if (raw !== '' && price === null) return { error: 'Harga tidak valid.' }
    const offered = formData.get(`offered-${b.teamId}`) === 'on'
    rows.push({ teamId: b.teamId, price, offered })
  }

  for (const { teamId, price, offered } of rows) {
    await db.execute(sql`
      insert into service_branch_overrides (service_id, team_id, organization_id, price, offered)
      values (${serviceId}, ${teamId}, ${organizationId}, ${price}, ${offered})
      on conflict (service_id, team_id) do update
        set price = excluded.price, offered = excluded.offered, updated_at = now()`)
  }
  revalidateService(serviceId)
  return { done: true }
}

/**
 * The whole set in one submit, same shape as setBranchOverrideAction:
 * checked staff are linked, unchecked staff are unlinked. Iterating
 * listPerformers(serviceId, organizationId) -- this org's own eligible
 * candidates -- rather than the submitted field names is the whole guard:
 * a performer-<foreignUserId> or performer-<ineligibleUserId> field a
 * crafted POST tacks on is simply never looked up. The delete and each
 * insert are both scoped by organization_id in the same statement, so a
 * service_staff row naming another salon's user can reach this table only
 * through the composite FK the migration refuses at the database (spec §7.14).
 */
export async function setPerformersAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  await requirePagePermission({ service: ['update'] })
  const { organizationId } = await requirePageOrg()
  const serviceId = String(formData.get('serviceId') ?? '')
  if (!serviceId || !(await ownedService(serviceId, organizationId))) return NOT_FOUND

  const candidates = await listPerformers(serviceId, organizationId)
  const checkedIds = candidates
    .filter((c) => formData.get(`performer-${c.userId}`) === 'on')
    .map((c) => c.userId)

  // drizzle's sql tag spreads a bare array into one placeholder per element
  // (right for an IN-list, wrong for any($1)), so `not in (...)` built via
  // sql.join is the list form, not a bound array parameter. An empty
  // checkedIds makes an empty "not in ()", which Postgres rejects -- so that
  // case skips the id filter entirely and just clears every row.
  if (checkedIds.length === 0) {
    await db.execute(sql`
      delete from service_staff
       where service_id = ${serviceId} and organization_id = ${organizationId}`)
  } else {
    const idList = sql.join(checkedIds.map((id) => sql`${id}`), sql`, `)
    await db.execute(sql`
      delete from service_staff
       where service_id = ${serviceId} and organization_id = ${organizationId}
         and user_id not in (${idList})`)
  }
  for (const userId of checkedIds) {
    await db.execute(sql`
      insert into service_staff (service_id, user_id, organization_id)
      values (${serviceId}, ${userId}, ${organizationId})
      on conflict (service_id, user_id) do nothing`)
  }
  revalidateService(serviceId)
  return { done: true }
}

export async function deactivateServiceAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  await requirePagePermission({ service: ['update'] })
  const { organizationId } = await requirePageOrg()
  const id = String(formData.get('id') ?? '')
  if (!id || !(await ownedService(id, organizationId))) return NOT_FOUND

  await db.execute(sql`
    update services set active = false, updated_at = now()
     where id = ${id} and organization_id = ${organizationId}`)
  revalidateService(id)
  return { done: true }
}

/**
 * Rehiring a service into a full plan is a 402, exactly like creating one --
 * requireQuota runs BEFORE the flip, so a tenant already at cap cannot
 * reactivate its way past it.
 */
export async function reactivateServiceAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  await requirePagePermission({ service: ['update'] })
  const { organizationId } = await requirePageOrg()
  const id = String(formData.get('id') ?? '')
  if (!id || !(await ownedService(id, organizationId))) return NOT_FOUND

  try {
    await requireQuota('services')
  } catch (e) {
    if (e instanceof PlanError) {
      return { error: 'Kuota layanan paket Anda sudah tercapai. Upgrade untuk menambah layanan.' }
    }
    return { error: formError(e, 'Gagal mengaktifkan layanan.') }
  }

  await db.execute(sql`
    update services set active = true, updated_at = now()
     where id = ${id} and organization_id = ${organizationId}`)
  revalidateService(id)
  return { done: true }
}
