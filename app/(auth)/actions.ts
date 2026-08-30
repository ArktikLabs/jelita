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

export async function forgotPasswordAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const email = String(formData.get('email') ?? '').trim()
  if (!email) return { error: 'Email wajib diisi.' }

  try {
    await auth.api.requestPasswordReset({
      body: { email, redirectTo: `${process.env.BETTER_AUTH_URL}/reset-password` },
    })
  } catch {
    // Swallowed on purpose: the response must not differ between a known and
    // an unknown address, or the form becomes an account-existence oracle.
  }
  return { done: true }
}

export async function resetPasswordAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const token = String(formData.get('token') ?? '')
  const password = String(formData.get('password') ?? '')
  const confirm = String(formData.get('confirm') ?? '')
  if (!token) return { error: 'Tautan tidak valid atau sudah kedaluwarsa.' }
  if (password.length < 8) return { error: 'Kata sandi minimal 8 karakter.' }
  if (password !== confirm) return { error: 'Konfirmasi kata sandi tidak cocok.' }

  try {
    await auth.api.resetPassword({ body: { token, newPassword: password } })
  } catch (e) {
    return { error: message(e, 'Tautan tidak valid atau sudah kedaluwarsa.') }
  }
  redirect('/login')
}
