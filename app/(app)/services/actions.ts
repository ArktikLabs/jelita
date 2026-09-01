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
  // toggle.
  //
  // TWO statements, ONE transaction -- a single UPDATE with `not exists` in
  // its own WHERE is NOT enough, confirmed by testing raw Postgres locking
  // directly: when this statement blocks on createServiceAction's row lock
  // and then unblocks, Postgres only re-checks the LOCKED ROW's own columns
  // against the concurrent write (EvalPlanQual) -- a `not exists` subquery
  // against a DIFFERENT table (services) still runs against the snapshot
  // this statement started with, so it does not see a service that
  // committed while this was blocked. The first statement below only takes
  // the row lock (serialising against createServiceAction's own lock on the
  // same row); the second is issued FRESH afterward, so it gets a brand new
  // READ COMMITTED snapshot that does see anything committed in the
  // meantime.
  const rowCount = await db.transaction(async (tx) => {
    await tx.execute(sql`
      select 1 from salon_profiles where organization_id = ${organizationId} for update`)
    const result = await tx.execute(sql`
      update salon_profiles set currency = ${currency}, updated_at = now()
       where organization_id = ${organizationId}
         and not exists (select 1 from services where organization_id = ${organizationId})`)
    return result.rowCount
  })
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
    // Spec 2.6, the other half of setCurrencyAction's guard: `price` above
    // was parsed against `currency`, so this insert must not land under a
    // DIFFERENT one. `insert ... select ... for update` locks the
    // salon_profiles row as part of the SAME statement that inserts --
    // serialising against setCurrencyAction's own row lock on that row (same
    // shape as deactivateStaffAction's/deactivateBranchAction's `for update`
    // precedent, coupling two different actions instead of two calls to the
    // same one). A bare lock-then-insert is NOT enough on its own: if the
    // currency change wins the race and commits first, an insert that only
    // locks and does not re-check would still go ahead with a price parsed
    // under the OLD currency -- reproduced 15/15 under concurrent load.
    // Re-checking `currency = ${currency}` against the row AFTER the lock is
    // what actually closes the race: if the row's currency moved while this
    // request was in flight, the select returns no rows and nothing is
    // inserted.
    const { rowCount } = await db.execute(sql`
      insert into services (id, organization_id, category_id, name,
                            duration_minutes, price)
      select ${crypto.randomUUID()}, ${organizationId}, ${categoryId},
             ${name}, ${duration}, ${price}
        from salon_profiles
       where organization_id = ${organizationId} and currency = ${currency}
         for update`)
    if (!rowCount) return { error: 'Mata uang salon berubah, coba lagi. Muat ulang halaman.' }
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
 * scope, and it is not a one-line addition when it is picked up: the FK
 * (db/migrations/0010_services.sql:83-85) is a COMPOSITE
 * on delete set null (category_id, organization_id), and Postgres nulls
 * ALL referencing columns, not just category_id -- services.organization_id
 * is NOT NULL, so deleting a category would raise a not-null violation, not
 * leave its services intact. Nothing deletes a category today, so this path
 * is unreached; whoever adds "hapus kategori" needs PG 15+'s
 * on delete set null (category_id) form, naming only that column.
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
    // A branch the form never rendered -- created after the page loaded --
    // submits no row-<teamId> marker at all, and that is NOT the same thing
    // as an unchecked "ditawarkan" checkbox (which submits no offered-<id>
    // but still carries its own row-<teamId>, since the row itself was
    // rendered). Skip it entirely: writing (price null, offered false) here
    // would silently hide a service at a branch the operator never saw a
    // toggle for.
    if (formData.get(`row-${b.teamId}`) === null) continue
    const raw = String(formData.get(`price-${b.teamId}`) ?? '').trim()
    // Empty means INHERITS. A value equal to the salon price is still an
    // override -- collapsing the two would silently stop a salon-wide price
    // change from reaching this branch (spec 2.1).
    const price = raw === '' ? null : parseMoney(raw, currency)
    if (raw !== '' && price === null) return { error: 'Harga tidak valid.' }
    const offered = formData.get(`offered-${b.teamId}`) === 'on'
    rows.push({ teamId: b.teamId, price, offered })
  }

  try {
    for (const { teamId, price, offered } of rows) {
      await db.execute(sql`
        insert into service_branch_overrides (service_id, team_id, organization_id, price, offered)
        values (${serviceId}, ${teamId}, ${organizationId}, ${price}, ${offered})
        on conflict (service_id, team_id) do update
          set price = excluded.price, offered = excluded.offered, updated_at = now()`)
    }
  } catch (e) {
    return { error: formError(e, 'Gagal memperbarui harga cabang.') }
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
  const candidateIds = candidates.map((c) => c.userId)
  const checkedIds = candidates
    .filter((c) => formData.get(`performer-${c.userId}`) === 'on')
    .map((c) => c.userId)

  // Scoped to CANDIDATE ids, not "everyone but checkedIds" -- a staff member
  // who fell out of listPerformers since the link was made (deactivated, or
  // reassigned off a branch) is not a candidate and must not be deleted just
  // because an unrelated edit touched this service. Their row survives until
  // they are a candidate again and someone explicitly unchecks them.
  const toUnlink = candidateIds.filter((id) => !checkedIds.includes(id))

  try {
    if (toUnlink.length > 0) {
      const idList = sql.join(toUnlink.map((id) => sql`${id}`), sql`, `)
      await db.execute(sql`
        delete from service_staff
         where service_id = ${serviceId} and organization_id = ${organizationId}
           and user_id in (${idList})`)
    }
    for (const userId of checkedIds) {
      await db.execute(sql`
        insert into service_staff (service_id, user_id, organization_id)
        values (${serviceId}, ${userId}, ${organizationId})
        on conflict (service_id, user_id) do nothing`)
    }
  } catch (e) {
    return { error: formError(e, 'Gagal memperbarui staf layanan.') }
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

  try {
    await db.execute(sql`
      update services set active = false, updated_at = now()
       where id = ${id} and organization_id = ${organizationId}`)
  } catch (e) {
    return { error: formError(e, 'Gagal menonaktifkan layanan.') }
  }
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
