'use server'

import { redirect } from 'next/navigation'
import { APIError } from 'better-auth/api'
import { auth } from '@/lib/auth'
import type { FormState } from '@/lib/form-state'

const message = (e: unknown, fallback: string) =>
  e instanceof APIError ? (e.body?.message as string) ?? fallback : fallback

export async function registerAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const name = String(formData.get('name') ?? '').trim()
  const email = String(formData.get('email') ?? '').trim()
  const password = String(formData.get('password') ?? '')
  if (!name || !email || !password) return { error: 'Semua kolom wajib diisi.' }

  try {
    await auth.api.signUpEmail({ body: { name, email, password } })
  } catch (e) {
    return { error: message(e, 'Pendaftaran gagal. Coba lagi.') }
  }
  // Deliberately identical whether or not the address was already taken —
  // better-auth returns a generic success for duplicates when verification is
  // required, so the form must not leak which case happened.
  return { done: true }
}

export async function loginAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const email = String(formData.get('email') ?? '').trim()
  const password = String(formData.get('password') ?? '')
  if (!email || !password) return { error: 'Email dan kata sandi wajib diisi.' }

  try {
    await auth.api.signInEmail({ body: { email, password } })
  } catch (e) {
    return { error: message(e, 'Email atau kata sandi salah.') }
  }
  redirect('/dashboard')
}
