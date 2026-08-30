'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { APIError } from 'better-auth/api'
import { auth } from '@/lib/auth'
import { getSession } from '@/lib/session'
import type { FormState } from '@/lib/form-state'

const fail = (e: unknown, fallback: string): FormState => ({
  error: e instanceof APIError ? (e.body?.message as string) ?? fallback : fallback,
})

export async function updateProfileAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  const name = String(formData.get('name') ?? '').trim()
  if (!name) return { error: 'Nama wajib diisi.' }
  try {
    await auth.api.updateUser({ body: { name }, headers: await headers() })
  } catch (e) { return fail(e, 'Gagal menyimpan.') }
  revalidatePath('/profile')
  return { done: true }
}

export async function changePasswordAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  const currentPassword = String(formData.get('current') ?? '')
  const newPassword = String(formData.get('next') ?? '')
  if (newPassword.length < 8) return { error: 'Kata sandi minimal 8 karakter.' }
  try {
    await auth.api.changePassword({
      body: { currentPassword, newPassword, revokeOtherSessions: true },
      headers: await headers(),
    })
  } catch (e) { return fail(e, 'Kata sandi saat ini salah.') }
  revalidatePath('/profile')
  return { done: true }
}

export async function revokeSessionAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  const token = String(formData.get('token') ?? '')
  const session = await getSession()
  if (session?.session.token === token) {
    return { error: 'Tidak bisa mencabut sesi yang sedang Anda gunakan.' }
  }
  try {
    await auth.api.revokeSession({ body: { token }, headers: await headers() })
  } catch (e) { return fail(e, 'Gagal mencabut sesi.') }
  revalidatePath('/profile')
  return { done: true }
}
