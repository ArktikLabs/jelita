'use server'

import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { sql } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { requirePageSession } from '@/lib/session'
import { formError, type FormState } from '@/lib/form-state'
import { isCurrencyCode } from '@/lib/money'

export async function createSalonAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await requirePageSession()
  // This action is a public POST endpoint in its own right, so the guard has
  // to live here and not only on the page: without it an already-onboarded
  // user can create a second organization, breaking the one-salon-per-user
  // assumption the session hook in lib/auth.ts depends on.
  if (session.session.activeOrganizationId) redirect('/dashboard')
  const name = String(formData.get('name') ?? '').trim()
  const slug = String(formData.get('slug') ?? '').trim().toLowerCase()
  const currency = String(formData.get('currency') ?? '')
  if (!name || !slug) return { error: 'Nama dan slug wajib diisi.' }
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return { error: 'Slug hanya boleh huruf kecil, angka, dan tanda hubung.' }
  }
  // An unrecognised code is a form error, never a stored value -- the
  // seeded row would otherwise be left on its IDR default with no signal.
  if (!isCurrencyCode(currency)) return { error: 'Mata uang tidak dikenali.' }

  try {
    const org = await auth.api.createOrganization({
      body: { name, slug },
      headers: await headers(),
    })
    if (org) {
      await auth.api.setActiveOrganization({
        body: { organizationId: org.id },
        headers: await headers(),
      })
      // organizations_seed_salon_profile already inserted this row,
      // defaulting to IDR (spec 7.2) -- this is an UPDATE to the chosen
      // currency, not an insert.
      await db.execute(sql`
        update salon_profiles set currency = ${currency}, updated_at = now()
         where organization_id = ${org.id}`)
    }
  } catch (e) {
    return { error: formError(e, 'Gagal membuat salon.') }
  }
  redirect('/dashboard')
}
