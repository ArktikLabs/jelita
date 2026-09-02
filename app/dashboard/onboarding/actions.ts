'use server'

import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { sql } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { requirePageSession } from '@/lib/session'
import { formError, type FormState } from '@/lib/form-state'
import { isCurrencyCode } from '@/lib/money'
import { slugProblem, type SlugProblem } from '@/lib/slug'

/** One message per rule: someone who typed `www` needs different advice from
 *  someone who typed `Ovarya!`. */
const SLUG_ERRORS: Record<SlugProblem, string> = {
  required: 'Nama dan slug wajib diisi.',
  chars: 'Slug hanya boleh huruf kecil, angka, dan tanda hubung.',
  edges: 'Slug tidak boleh diawali atau diakhiri tanda hubung.',
  length: 'Slug maksimal 63 karakter.',
  reserved: 'Slug ini sudah dipakai sistem. Coba nama lain.',
}

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
  if (!name) return { error: 'Nama dan slug wajib diisi.' }
  // The slug becomes a SUBDOMAIN (ovarya.atjelita.com/book), so these are DNS
  // rules, not cosmetics -- see lib/slug.ts. The character rule was already
  // here; the shape and reserved-name rules were harmless until the slug
  // started resolving a hostname.
  const problem = slugProblem(slug)
  if (problem) return { error: SLUG_ERRORS[problem] }
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
