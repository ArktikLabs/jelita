# Email at Parity with WhatsApp — Design

**Date:** 2026-09-04
**Status:** built. §2 answered: option (a).
**Covers:** the email half of PRD §5.5's adapter

## 1. Goal

Auth email — password reset, email verification, staff invitation — gets what
WhatsApp got: a real transport, admin-editable templates, and rows in the
Notification Center.

Today all three go through `notify()` to the `.mail.log` transport with their
wording hardcoded in `lib/auth.ts`. On Vercel there is no writable filesystem,
so **today nothing sends in production at all**.

## 2. The decision this needs

**A password-reset link stored in `notifications.body` is account takeover.**

`notification:['read']` is held by owner, admin AND front desk. Storing the
reset URL as sent means any front-desk login can open the Center, read the
owner's reset link, and take the account. The same is true of a verification
link. This is not a theoretical objection: the Center's entire purpose is to
display the message body to whoever can reach the page.

Three ways out:

**(a) Store the wording, not the secret.** The body is stored with `{{link}}`
left unsubstituted; the link is filled in only for the message actually sent.
The Center shows the exact wording, the templates are fully editable, and the
secret never lands in a table. **Recommended.**

**(b) Restrict auth-email rows to `settings:['update']`** (owner and admin).
Narrower than today's Center, and still puts live reset links in the database
where a backup or a support session exposes them.

**(c) Record no body for auth email.** The Center shows that a message went
and to whom. Safe, and gives up the thing §5.5 was for.

Everything below assumes **(a)**. It is the only option that keeps the demo
claim honest without creating a credential store.

## 3. What parity means for a transactional message

**Sending is IMMEDIATE, never queued behind the cron.** A password reset that
waits up to fifteen minutes for `/api/cron/notifications` is broken. These
messages are written to `notifications` and dispatched in the same call,
landing as `sent` rather than `queued`.

So the queue is not the mechanism; it is the record. The four booking messages
are scheduled; the three auth messages are immediate. Same table, same
templates, same Center, different dispatch — and `send_at` already distinguishes
them without a new column.

## 4. Schema

`notifications.organization_id` and `team_id` become **nullable**.

A verification email at signup has neither: the account exists, the salon does
not. Making them nullable is what lets the row exist at all.

Where an org CAN be resolved it is: a password reset for someone who is
already a member of one salon carries that organization, so it appears in that
salon's Center. A brand-new signup's verification carries none and is
therefore invisible to everyone — stated here rather than discovered later.

The `kind` check constraint gains `password_reset`, `email_verification`,
`invitation`. The `channel` column already exists and already carries `email`.

## 5. Templates

Three more rows per salon, seeded by the same trigger, with their own
placeholders: `{{name}}`, `{{salon}}`, `{{inviter}}`, and `{{link}}`.

`{{link}}` is the one placeholder `render` must NOT substitute at store time
(§2a). That is a rule about one name, and a rule about one name is exactly the
kind of thing that gets forgotten — so it is `renderPublic()`, a separate
function, rather than an argument to the existing one.

An orgless message renders from a built-in default, since there is no salon
whose template could apply.

## 6. The transport

`Transport` and the `transports` record already exist and already route
`email`. This slice writes ONE real transport — Resend, chosen because it
needs an API key and nothing else — and swaps the entry.

`.mail.log` stays as the default when `RESEND_API_KEY` is unset, because the
e2e suite reads it (`tests/e2e/mail.ts`) to drive the auth flows. Choosing the
transport by env, not by deleting the old one.

## 7. Testing

1. `renderPublic` substitutes everything EXCEPT `{{link}}`.
2. A stored auth-email body never contains the URL, for all three kinds.
3. The sent message DOES contain it.
4. Reset and verification send immediately -- `sent`, not `queued`.
5. The cron does not pick them up (there is nothing queued to pick up).
6. A password reset for a salon member lands in that salon's Center.
7. A signup verification with no org writes a row scoped to no salon.
8. Editing an email template changes the next message, not the last.
9. Front desk cannot edit the templates; the existing guard already covers it.
10. With `RESEND_API_KEY` unset, the log transport is still chosen.

**Break-and-restore evidence for each**, and #2 is the one that matters: break
it by substituting `{{link}}` at store time and watch the URL appear in the
table.


## 8. What the build found

**The Center's hundred-row limit hid every sent message.** The demo salon
carries more queued reminders than the page shows, and auth email is always
`sent` -- so the entire email half was unreachable the moment it was built. A
status filter, not a bigger limit.

**`Record<NotificationKind, string>` caught the missing labels.** Adding three
kinds failed the build on `lib/notification-kinds.ts` until all three had a
label, which is the type doing the job a runtime lookup would have done
silently and blankly. Same class of bug as the empty column in the last slice,
caught for free this time.

**The e2e assertion matched the filter button, not a row.** "no queued row
survives the sent filter" passed against a page whose *control* is labelled
`Antre`. Scoped to `tbody` now. A page-wide `not.toContain` on a page that
contains its own controls is nearly always testing the control.
