ALTER TABLE "notifications" ALTER COLUMN "organization_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ALTER COLUMN "team_id" DROP NOT NULL;--> statement-breakpoint
-- Auth email joins the same queue: password reset, verification, invitation.
alter table notifications drop constraint notifications_kind;
--> statement-breakpoint
alter table notifications add constraint notifications_kind check (
  kind in ('booking_confirmed', 'reminder_day_before', 'reminder_2h', 'thank_you',
           'password_reset', 'email_verification', 'invitation'));
--> statement-breakpoint
alter table notification_templates drop constraint notification_templates_kind;
--> statement-breakpoint
alter table notification_templates add constraint notification_templates_kind check (
  kind in ('booking_confirmed', 'reminder_day_before', 'reminder_2h', 'thank_you',
           'password_reset', 'email_verification', 'invitation'));
--> statement-breakpoint
-- {{link}} is deliberately NOT substituted when the body is stored: the
-- Notification Center displays it, and notification:['read'] reaches front
-- desk, so a stored reset URL would be account takeover. The link is filled in
-- only for the message that actually goes out. See lib/notify.ts sendNow, and
-- docs/superpowers/specs/2026-09-04-email-parity-design.md §2.
create or replace function seed_notification_templates() returns trigger
language plpgsql as $$
begin
  insert into notification_templates (organization_id, kind, body)
  values
    (new.id, 'booking_confirmed',
     'Halo {{customer}}, booking Anda di {{salon}} untuk {{service}} bersama {{staff}} pada {{date}} pukul {{time}} sudah kami terima. Sampai jumpa!'),
    (new.id, 'reminder_day_before',
     'Halo {{customer}}, pengingat: besok {{date}} pukul {{time}} Anda ada janji {{service}} bersama {{staff}} di {{salon}}. Sampai jumpa!'),
    (new.id, 'reminder_2h',
     'Halo {{customer}}, janji {{service}} Anda di {{salon}} mulai pukul {{time}} hari ini. Sampai jumpa sebentar lagi!'),
    (new.id, 'thank_you',
     'Terima kasih sudah datang ke {{salon}}, {{customer}}! Semoga Anda suka hasilnya. Sampai jumpa lagi ya.'),
    (new.id, 'password_reset',
     'Halo {{name}}, klik tautan berikut untuk mengatur ulang kata sandi {{salon}} Anda: {{link}}'),
    (new.id, 'email_verification',
     'Halo {{name}}, klik tautan berikut untuk memverifikasi email Anda: {{link}}'),
    (new.id, 'invitation',
     '{{inviter}} mengundang Anda bergabung di {{salon}}. Klik untuk menerima: {{link}}')
  on conflict do nothing;
  return new;
end $$;
--> statement-breakpoint
insert into notification_templates (organization_id, kind, body)
select o.id, t.kind, t.body
  from organizations o
  cross join (values
    ('password_reset', 'Halo {{name}}, klik tautan berikut untuk mengatur ulang kata sandi {{salon}} Anda: {{link}}'),
    ('email_verification', 'Halo {{name}}, klik tautan berikut untuk memverifikasi email Anda: {{link}}'),
    ('invitation', '{{inviter}} mengundang Anda bergabung di {{salon}}. Klik untuk menerima: {{link}}')
  ) as t(kind, body)
  on conflict do nothing;
