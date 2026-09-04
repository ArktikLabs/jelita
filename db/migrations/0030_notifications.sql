CREATE TABLE "notification_templates" (
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_templates_organization_id_kind_pk" PRIMARY KEY("organization_id","kind")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"team_id" text NOT NULL,
	"booking_id" text,
	"customer_id" text,
	"kind" text NOT NULL,
	"channel" text DEFAULT 'whatsapp' NOT NULL,
	"to" text NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"send_at" timestamp NOT NULL,
	"sent_at" timestamp with time zone,
	"provider" text,
	"provider_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_one_per_event" UNIQUE("booking_id","kind")
);
--> statement-breakpoint
ALTER TABLE "notification_templates" ADD CONSTRAINT "notification_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_due_idx" ON "notifications" USING btree ("organization_id","status","send_at");--> statement-breakpoint
-- The booking a message is about. Cascade: a deleted booking's unsent
-- reminders are not messages anybody wants delivered.
alter table notifications
  add constraint notifications_booking_fk foreign key (booking_id)
  references bookings (id) on delete cascade;
--> statement-breakpoint
alter table notifications
  add constraint notifications_team_fk foreign key (team_id)
  references teams (id) on delete cascade;
--> statement-breakpoint
alter table notifications
  add constraint notifications_customer_fk foreign key (customer_id)
  references customers (id) on delete set null;
--> statement-breakpoint
alter table notifications add constraint notifications_kind check (
  kind in ('booking_confirmed', 'reminder_day_before', 'reminder_2h', 'thank_you'));
--> statement-breakpoint
alter table notification_templates add constraint notification_templates_kind check (
  kind in ('booking_confirmed', 'reminder_day_before', 'reminder_2h', 'thank_you'));
--> statement-breakpoint
-- `sent_at` and `status` cannot disagree. A row claiming to be sent with no
-- time is a record of nothing, and the Notification Center reads both.
alter table notifications add constraint notifications_status check (
  status in ('queued', 'sent', 'failed', 'cancelled')
  and (status = 'sent') = (sent_at is not null));
--> statement-breakpoint
-- A SENT message is history. Everything else about it may still change --
-- queued -> sent is the whole point, and queued -> cancelled is what a
-- cancelled booking does -- but once it has gone out, it is what happened.
--
-- Same rule the settled transaction, the closed payroll month and the points
-- ledger use, and for the same reason: a record of what happened that can be
-- edited afterwards is not a record.
create or replace function notifications_sent_immutable() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'notification % has been sent and cannot be deleted', old.id
      using errcode = 'restrict_violation';
  end if;
  raise exception 'notification % has been sent and cannot be changed', old.id
    using errcode = 'restrict_violation';
end $$;
--> statement-breakpoint
create trigger notifications_sent_immutable
  before update or delete on notifications
  for each row when (old.status = 'sent')
  execute function notifications_sent_immutable();
--> statement-breakpoint
-- A new salon gets working messages on day one. An unconfigured template
-- means every booking queues an empty message -- a failure nobody sees until
-- a customer does. Same reason a new hire is seeded a seven-day pattern.
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
     'Terima kasih sudah datang ke {{salon}}, {{customer}}! Semoga Anda suka hasilnya. Sampai jumpa lagi ya.')
  on conflict do nothing;
  return new;
end $$;
--> statement-breakpoint
create trigger organizations_seed_notification_templates
  after insert on organizations
  for each row execute function seed_notification_templates();
--> statement-breakpoint
-- Backfill the salons that already exist.
insert into notification_templates (organization_id, kind, body)
select o.id, t.kind, t.body
  from organizations o
  cross join (values
    ('booking_confirmed', 'Halo {{customer}}, booking Anda di {{salon}} untuk {{service}} bersama {{staff}} pada {{date}} pukul {{time}} sudah kami terima. Sampai jumpa!'),
    ('reminder_day_before', 'Halo {{customer}}, pengingat: besok {{date}} pukul {{time}} Anda ada janji {{service}} bersama {{staff}} di {{salon}}. Sampai jumpa!'),
    ('reminder_2h', 'Halo {{customer}}, janji {{service}} Anda di {{salon}} mulai pukul {{time}} hari ini. Sampai jumpa sebentar lagi!'),
    ('thank_you', 'Terima kasih sudah datang ke {{salon}}, {{customer}}! Semoga Anda suka hasilnya. Sampai jumpa lagi ya.')
  ) as t(kind, body)
  on conflict do nothing;
