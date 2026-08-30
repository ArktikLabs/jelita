'use server'

import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { requirePageSession } from '@/lib/session'
import { formError, type FormState } from '@/lib/form-state'

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
  if (!name || !slug) return { error: 'Nama dan slug wajib diisi.' }
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return { error: 'Slug hanya boleh huruf kecil, angka, dan tanda hubung.' }
  }

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
    }
  } catch (e) {
    return { error: formError(e, 'Gagal membuat salon.') }
  }
  redirect('/dashboard')
}
