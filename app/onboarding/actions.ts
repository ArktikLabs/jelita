'use server'

import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { APIError } from 'better-auth/api'
import { auth } from '@/lib/auth'
import { requirePageSession } from '@/lib/session'
import type { FormState } from '@/lib/form-state'

export async function createSalonAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  await requirePageSession()
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
    return {
      error: e instanceof APIError
        ? (e.body?.message as string) ?? 'Slug sudah dipakai.'
        : 'Gagal membuat salon.',
    }
  }
  redirect('/dashboard')
}
