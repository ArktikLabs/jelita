import { expect, request, test } from '@playwright/test'
import { Pool } from 'pg'
import { TEST_DATABASE_URL } from '../db'
import { clearMail, waitForMail } from './mail'

const DOMAIN = 'uicheck.local'
const EMAIL = `owner@${DOMAIN}`
const PW = 'demo12345'
const NEW_PW = 'newpass12345'

const pool = new Pool({ connectionString: TEST_DATABASE_URL })

const BASE_URL = 'http://localhost:3100'

/**
 * A cookie jar of its own, never following redirects -- the redirect itself is
 * what most of these assertions are about.
 *
 * The Origin header is not optional: better-auth's CSRF check rejects a
 * state-changing call without one (MISSING_OR_NULL_ORIGIN, 403). A browser
 * sends it automatically; a request context does not.
 */
const client = () => request.newContext({
  maxRedirects: 0,
  extraHTTPHeaders: { origin: BASE_URL },
})

test.beforeAll(async () => {
  await pool.query(`delete from organizations where slug like 'uicheck%'`)
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`])
  clearMail()
})

test.afterAll(async () => {
  await pool.end()
})

// Serial: each step builds on the account the previous one created.
test.describe.serial('routing and the auth flow', () => {
  test('anonymous visitors are bounced to /login', async () => {
    const anon = await client()
    for (const path of ['/dashboard', '/onboarding', '/profile']) {
      const res = await anon.get(path)
      expect(res.headers()['location'], `${path} should redirect`).toContain('/login')
    }
    await anon.dispose()
  })

  test('register, verify, auto sign-in, then land on onboarding', async () => {
    const user = await client()
    const signup = await user.post('/api/auth/sign-up/email', {
      data: { name: 'UI Check', email: EMAIL, password: PW },
    })
    expect(signup.status()).toBe(200)

    const verifyUrl = await waitForMail(/(https?:\/\/\S*verify-email\S*)/)
    expect(verifyUrl).toBeTruthy()

    await user.get(new URL(verifyUrl).pathname + new URL(verifyUrl).search)
    const cookies = (await user.storageState()).cookies
    expect(cookies.length, 'following the link should sign the user in').toBeGreaterThan(0)

    const afterVerify = await user.get('/dashboard')
    expect(afterVerify.headers()['location'],
      'a verified user with no salon belongs on onboarding').toContain('/onboarding')
    await user.dispose()
  })

  test('onboarding creates the salon and opens the app', async () => {
    const user = await client()
    await user.post('/api/auth/sign-in/email', { data: { email: EMAIL, password: PW } })
    const created = await user.post('/api/auth/organization/create',
      { data: { name: 'UI Check Salon', slug: 'uicheck' } })
    expect(created.status(), await created.text()).toBe(200)
    const { rows } = await pool.query(`select id from organizations where slug = 'uicheck'`)
    await user.post('/api/auth/organization/set-active',
      { data: { organizationId: rows[0].id } })

    expect((await user.get('/dashboard')).status()).toBe(200)
    expect((await user.get('/onboarding')).headers()['location'],
      'an onboarded user should not see onboarding again').toContain('/dashboard')
    expect((await user.get('/login')).headers()['location'],
      'a signed-in user should not see the login page').toContain('/dashboard')
    await user.dispose()
  })

  test('password reset round trip', async () => {
    clearMail()
    const requester = await client()
    await requester.post('/api/auth/request-password-reset', {
      data: { email: EMAIL, redirectTo: `${BASE_URL}/reset-password` },
    })
    const token = await waitForMail(/token=([A-Za-z0-9._-]+)/)
    expect(token).toBeTruthy()
    await requester.dispose()

    const resetter = await client()
    const reset = await resetter.post('/api/auth/reset-password',
      { data: { token, newPassword: NEW_PW } })
    expect(reset.status()).toBe(200)
    await resetter.dispose()

    const withOld = await client()
    expect((await withOld.post('/api/auth/sign-in/email',
      { data: { email: EMAIL, password: PW } })).status(),
      'the old password must stop working').toBeGreaterThanOrEqual(400)
    await withOld.dispose()

    const withNew = await client()
    expect((await withNew.post('/api/auth/sign-in/email',
      { data: { email: EMAIL, password: NEW_PW } })).status()).toBe(200)
    await withNew.dispose()
  })

  test('a garbage reset token renders rather than crashing', async () => {
    const anon = await client()
    expect((await anon.get('/reset-password?token=garbage')).status()).toBe(200)
    await anon.dispose()
  })
})
