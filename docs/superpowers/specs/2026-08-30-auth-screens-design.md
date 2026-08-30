# Auth Screens — Design

**Status:** Approved design, not yet implemented
**Date:** 30 August 2026
**Context:** Jelita / Arktik Salon Suite (see `docs/prd-salon-management-mvp.md`)

---

## 1. Context

The authentication *engine* is built and tested — 70 assertions covering
sign-up, sign-in, sign-out, sessions, change password, forgot/reset password,
invitations, role assignment, runtime custom roles, branch scoping and
permission enforcement in both directions. Plan gating sits on top of it.

None of it has a user interface. The repository contains exactly one page, a
three-line placeholder, and `lib/auth-client.ts` is dead code because nothing
signs in from a browser.

This design covers the first screens in the codebase. They are thin forms over
endpoints that already work, but they establish the layout, form, guard and
error conventions every later screen inherits.

## 2. Goals

- A stranger can register, verify, sign in, create their salon, and recover a
  lost password without anyone touching a database.
- Account settings: change name, change password, see and revoke sessions.
- Outbound messages go through a **channel adapter** so WhatsApp, email and
  Telegram transports plug in later without touching call sites (PRD §5.5).

## 3. Non-goals

- No real email/WhatsApp provider. The file transport stays.
- No design system beyond the shadcn/ui components these screens use.
- No branch management, dashboard content, or booking UI.
- No social login, no 2FA, no magic links.
- No `proxy.ts`. Secure checks already live in the data layer; optimistic
  redirects are polish, addable later without rework.

## 4. Decisions

| Question | Decision | Rationale |
|---|---|---|
| Account creation | Public self-serve signup | Real SaaS funnel; the free tier exists for it |
| Outbound delivery | Channel adapter, `.mail.log` transport | PRD §5.5 requires the adapter; a provider is a credentials swap |
| Entry flow | Register → verify → login → onboarding | Keeps salon creation out of the signup transaction |
| Components | shadcn/ui on Tailwind | Accessible primitives; Tailwind is already the mandated stack |
| Forms | Server Actions, not client `authClient` | No auth logic in the browser; works without JS |

**Accepted trade:** until a transport is wired, a stranger cannot complete
signup without reading `.mail.log`. Self-serve in shape, invite-only in
practice.

## 5. Routes and guards

```
app/
  (auth)/                     public; bounce to /dashboard if already signed in
                              (a user with no org then hops on to /onboarding
                              via the (app) guard — two redirects, by design)
    layout.tsx                centered-card shell
    login/page.tsx
    register/page.tsx
    verify-email/page.tsx     confirmation landing (user is already signed in)
    forgot-password/page.tsx
    reset-password/page.tsx   reads ?token=
  onboarding/page.tsx         authenticated, NO org yet — outside (app) by design
  (app)/                      authenticated AND has an organization
    layout.tsx                the guard
    dashboard/page.tsx        stub landing
    profile/page.tsx          name, change password, sessions
```

`onboarding` sits outside `(app)` deliberately: the `(app)` layout redirects
anyone without an `activeOrganizationId` to `/onboarding`, so onboarding inside
that group would redirect to itself forever. It carries a lighter guard —
session required, organization not.

**Two new page-level guards** in `lib/session.ts`, alongside the existing ones:

```ts
requirePageSession()   // session, else redirect('/login')
requirePageOrg()       // + activeOrganizationId, else redirect('/onboarding')
```

The existing `requireUser()` and `requirePermission()` **throw**, which is
correct for API routes that must return a status code. Pages need to redirect.
Same session read, different failure behaviour — two honest functions rather
than one that guesses its caller's context.

**Verified against the installed versions, and contrary to most tutorials:**

- `middleware.ts` is **deprecated in Next 16 and renamed to `proxy.ts`**, now
  defaulting to the Node runtime. We add neither, but every better-auth guide
  online says `middleware.ts`.
- **`verify-email` is not a token-consuming page.** better-auth owns
  `GET /api/auth/verify-email?token=…&callbackURL=…`; it validates and
  redirects to our `callbackURL`. Our page is a confirmation screen and never
  touches the token. Building a token handler would duplicate the library.
- `reset-password` **does** take its token from the query string, because
  `POST /reset-password` expects `{ token, newPassword }`.

## 6. Notification adapter

One file, `lib/notify.ts`, replacing `lib/mailer.ts`:

```ts
export type Channel = 'email' | 'whatsapp' | 'telegram'
export type Message = { channel: Channel; to: string; subject?: string; body: string }
type Transport = (m: Message) => Promise<void>

const logTransport: Transport = async (m) => { /* console + .mail.log */ }

// One transport today. Wiring a real channel is: write the transport,
// swap the entry. Nothing above this line changes.
const transports: Record<Channel, Transport> = {
  email: logTransport,
  whatsapp: logTransport,
  telegram: logTransport,
}

export const notify = (m: Message) => transports[m.channel](m)
```

Deliberately **no** `registerTransport()` and **no** env-var branching: nothing
registers anything today, and a `RESEND_API_KEY` check guarding a transport
that does not exist is a branch guarding nothing. The swap point is one line in
a literal.

**Where this stops short, on purpose.** PRD §5.5 also wants notifications
persisted with `queued`/`sent` status and admin-editable templates — the
Notification Center. That needs the `notifications` and `notification_templates`
tables from the unbuilt business schema. When they land, `logTransport` gains a
sibling that writes a row and `notify()` is unchanged. This adapter is not the
whole of §5.5.

## 7. Auth configuration

```ts
emailAndPassword: {
  requireEmailVerification: true,        // was false
  sendResetPassword: → notify({ channel: 'email', … }),
},
emailVerification: {
  sendOnSignUp: true,
  autoSignInAfterVerification: true,     // verifying is proof of possession;
                                         // don't charge a second login for it
  sendVerificationEmail: → notify({ channel: 'email', … }),
},
```

The existing invitation email moves to `notify()`.

All four options were confirmed to typecheck against better-auth 1.7.2.

**Rate limiting — resolved empirically.** Thirty rapid failed sign-ins against
the dev server all returned 401 and never 429, so limiting is not active in
development by default. Configure the paths that matter and never set `enabled`:

```ts
rateLimit: {
  // No `enabled` key on purpose. The default is production-only, which is what
  // we want; setting enabled:true forces it on in dev and trips the suites.
  customRules: {
    '/sign-up/email':          { window: 3600, max: 5 },
    '/sign-in/email':          { window: 60,   max: 10 },
    '/request-password-reset': { window: 3600, max: 5 },
  },
},
```

Five signups per hour is deliberately tight — a salon owner registers once.
Ten sign-ins a minute tolerates a fat-fingered password without locking out a
busy front desk. `customRules` was confirmed to typecheck.

Residual: dev was proven unlimited; production was **not** proven limited.
Worth one check against a production build before launch.

## 8. Screens

| Screen | Fields | Calls | On success |
|---|---|---|---|
| `/register` | name, email, password | `signUpEmail` | "check your email" state |
| `/verify-email` | — | none (token already consumed) | `/dashboard` → `/onboarding` |
| `/login` | email, password | `signInEmail` | `/dashboard`, or `/onboarding` if no org |
| `/forgot-password` | email | `requestPasswordReset` | "if that address exists, we sent a link" |
| `/reset-password?token=` | new password ×2 | `resetPassword` | `/login` |
| `/onboarding` | salon name, slug | `organization.create` + `setActive` | `/dashboard` |
| `/dashboard` | — | — | stub; the branch selector's future home |
| `/profile` | name; current + new password | `updateUser`, `changePassword` | inline confirmation |
| `/profile` (sessions card) | — | `listSessions`, `revokeSession` | list refreshes |

Sessions live **on** the profile page as a second card rather than a separate
route — it is account settings either way, and one page beats two.

shadcn `card`, `input`, `label`, `button` and `alert` cover all nine. No
bespoke widgets in this slice.

### Anti-enumeration is deliberate

With `requireEmailVerification: true`, better-auth returns a **generic success
for duplicate registrations** (`sign-up.mjs:163` — the same flag sets
`shouldReturnGenericDuplicateResponse`). Registering with a taken address shows
"check your email", not "that email is taken".

This is correct for a public form: one that says "taken" is a free
account-existence oracle. It is the same mechanism that was **rejected**
earlier for staff provisioning, where a silent fake success would have made an
owner believe they had created a stylist who did not exist. Same flag, opposite
verdict, because the caller differs. `/api/staff` is unaffected — it builds the
user through `internalAdapter` with an explicit `EMAIL_TAKEN` check.

`/forgot-password` gets the same treatment: always "if that address exists",
never "no such user".

### Onboarding

The only real logic is slug availability. `organization.checkSlug` exists, so
the field validates on blur rather than failing on submit — a slug collision at
the moment of signup is otherwise a confusing dead end.

## 9. Testing

**No browser runner.** Every screen is a thin form over a covered endpoint; the
genuinely new logic is routing, which is testable with `fetch` and
`redirect: 'manual'` in the existing assert-and-count style. Playwright would
be a large dependency for nine forms. It earns its place when there is a
booking calendar or POS cart with real interaction.

**New — `scripts/ui-check.mjs`:**

1. `GET /dashboard` anonymous → 307 to `/login`
2. `GET /onboarding` anonymous → 307 to `/login`
3. verified user with no org → `/dashboard` redirects to `/onboarding`
4. user with an org → `/onboarding` redirects to `/dashboard`
5. signed-in user → `/login` redirects to `/dashboard`
6. `/reset-password` with a garbage token renders the error state, does not 500
7. register → read the verification URL from `.mail.log` → follow it → the
   user is verified AND signed in, landing on `/onboarding`
8. forgot-password → read the reset URL → reset → old password dead, new
   password works

Checks 7 and 8 are a direct benefit of the file transport: the whole
verification flow is end-to-end testable with no inbox and no mocking.

## 10. Forced changes to existing work

1. **`scripts/auth-check.mjs` users must be marked verified during setup** — a
   direct `users` update in its section-0 fixture block, the same way it already
   puts its org on the `business` plan. Not by weakening the setting.
2. **Its "duplicate email rejected" assertion is rewritten** to assert the
   generic response. Anti-enumeration is the more valuable property.
3. **`lib/auth-client.ts` is deleted.** Server Actions mean nothing signs in
   from the browser. The repo audit already flagged it as dead.
4. **`lib/mailer.ts` is replaced by `lib/notify.ts`**; call sites in
   `lib/auth.ts` move to `notify()`.

## 11. Deferred, with the trigger for revisiting

- **Real transport (email or WhatsApp).** Revisit when a stranger needs to
  complete signup unaided, or when booking notifications ship.
- **`proxy.ts` optimistic redirects.** Revisit if the pre-redirect render is
  visibly annoying.
- **Confirming production rate limiting.** Revisit against a production build.
- **Playwright.** Revisit at the first genuinely interactive screen.
- **Social login, 2FA, magic links.** No demand yet.
