/**
 * Routing and end-to-end auth-flow checks. No browser: the new logic here is
 * redirects, which fetch can assert directly.
 *   pnpm ui:check      (dev server must be running)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { Pool } from 'pg'

const ORIGIN = process.env.BETTER_AUTH_URL
const DOMAIN = 'uicheck.local'
const PW = 'demo12345'

let pass = 0, fail = 0
const ok = (n, c, d) => (c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${n}`))
                           : (fail++, console.log(`  \x1b[31m✗\x1b[0m ${n}  ${d ?? ''}`)))
const head = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`)

class Client {
  constructor() { this.jar = new Map() }
  async go(path, { method = 'GET', body } = {}) {
    const headers = { origin: ORIGIN }
    if (body) headers['content-type'] = 'application/json'
    if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ')
    const res = await fetch(ORIGIN + path, {
      method, headers,
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    })
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const kv = c.split(';')[0], i = kv.indexOf('=')
      const name = kv.slice(0, i), val = kv.slice(i + 1)
      if (val === '') this.jar.delete(name)
      else this.jar.set(name, val)
    }
    return { status: res.status, location: res.headers.get('location'), res }
  }
}

const pool = new Pool({ connectionString: process.env.DIRECT_URL })
const lands = (r, path) => (r.location ?? '').includes(path)

try {
  head('0. reset fixtures')
  await pool.query(`delete from organizations where slug like 'uicheck%'`)
  await pool.query(`delete from users where email like $1`, [`%@${DOMAIN}`])
  writeFileSync('.mail.log', '')
  ok('cleared', true)

  head('1. anonymous visitors are bounced to /login')
  const anon = new Client()
  ok('/dashboard redirects to /login', lands(await anon.go('/dashboard'), '/login'))
  ok('/onboarding redirects to /login', lands(await anon.go('/onboarding'), '/login'))
  ok('/profile redirects to /login', lands(await anon.go('/profile'), '/login'))

  head('2. register → verify → auto sign-in → onboarding')
  const u = new Client()
  const signup = await u.go('/api/auth/sign-up/email', {
    method: 'POST',
    body: { name: 'UI Check', email: `owner@${DOMAIN}`, password: PW },
  })
  ok('sign-up accepted', signup.status === 200, `got ${signup.status}`)

  await new Promise((r) => setTimeout(r, 500))
  const verifyUrl = readFileSync('.mail.log', 'utf8').match(/(https?:\/\/\S*verify-email\S*)/)?.[1]
  ok('verification link delivered', !!verifyUrl)

  await u.go(verifyUrl.replace(ORIGIN, ''))
  ok('following the link signs the user in', u.jar.size > 0, 'no session cookie set')

  const afterVerify = await u.go('/dashboard')
  ok('verified user with no salon lands on /onboarding',
    lands(afterVerify, '/onboarding'), `got ${afterVerify.status} ${afterVerify.location}`)

  head('3. onboarding creates the salon and opens the app')
  await u.go('/api/auth/organization/create', {
    method: 'POST', body: { name: 'UI Check Salon', slug: 'uicheck' },
  })
  const org = await pool.query(`select id from organizations where slug = 'uicheck'`)
  await u.go('/api/auth/organization/set-active', {
    method: 'POST', body: { organizationId: org.rows[0].id },
  })
  const dash = await u.go('/dashboard')
  ok('user with a salon reaches /dashboard', dash.status === 200, `got ${dash.status}`)
  const reverse = await u.go('/onboarding')
  ok('/onboarding redirects an onboarded user to /dashboard',
    lands(reverse, '/dashboard'), `got ${reverse.status} ${reverse.location}`)
  ok('/login redirects a signed-in user to /dashboard',
    lands(await u.go('/login'), '/dashboard'))

  head('4. password reset round trip')
  writeFileSync('.mail.log', '')
  await new Client().go('/api/auth/request-password-reset', {
    method: 'POST',
    body: { email: `owner@${DOMAIN}`, redirectTo: `${ORIGIN}/reset-password` },
  })
  await new Promise((r) => setTimeout(r, 500))
  const token = readFileSync('.mail.log', 'utf8').match(/token=([A-Za-z0-9._-]+)/)?.[1]
  ok('reset token delivered', !!token)

  const reset = await new Client().go('/api/auth/reset-password', {
    method: 'POST', body: { token, newPassword: 'newpass12345' },
  })
  ok('password reset accepted', reset.status === 200, `got ${reset.status}`)

  const old = await new Client().go('/api/auth/sign-in/email', {
    method: 'POST', body: { email: `owner@${DOMAIN}`, password: PW },
  })
  ok('old password no longer works', old.status >= 400, `got ${old.status}`)
  const fresh = await new Client().go('/api/auth/sign-in/email', {
    method: 'POST', body: { email: `owner@${DOMAIN}`, password: 'newpass12345' },
  })
  ok('new password works', fresh.status === 200, `got ${fresh.status}`)

  head('5. a bad reset token renders, does not crash')
  const bad = await new Client().go('/reset-password?token=garbage')
  ok('/reset-password with a garbage token renders', bad.status === 200, `got ${bad.status}`)
} catch (e) {
  fail++
  console.error('\n\x1b[31mFATAL\x1b[0m', e.stack)
} finally {
  await pool.end()
}

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`)
process.exit(fail ? 1 : 0)
