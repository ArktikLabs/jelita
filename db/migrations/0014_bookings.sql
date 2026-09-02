CREATE TABLE "bookings" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"team_id" text NOT NULL,
	"staff_user_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"service_id" text NOT NULL,
	"starts_at" timestamp NOT NULL,
	"ends_at" timestamp NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"duration_minutes" smallint NOT NULL,
	"price" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "salon_profiles" ADD COLUMN "slot_minutes" smallint DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bookings_day_idx" ON "bookings" USING btree ("organization_id","team_id","starts_at");--> statement-breakpoint
-- 7-minute grids are a bug, not a business model. The allow-list is also what
-- makes generate_series safe in available_slots (spec 3.1).
alter table salon_profiles add constraint salon_profiles_slot_minutes
  check (slot_minutes in (15, 20, 30, 45, 60));
--> statement-breakpoint
alter table bookings add constraint bookings_times
  check (ends_at > starts_at);
--> statement-breakpoint
alter table bookings add constraint bookings_status
  check (status in ('pending', 'confirmed', 'completed', 'cancelled', 'no_show'));
--> statement-breakpoint
-- Cross-tenant rows are UNREPRESENTABLE, not merely filtered: every target
-- already carries the matching unique constraint, so these reference the pair
-- rather than the id alone (spec 3.4).
alter table bookings
  add constraint bookings_org_team_fk foreign key (team_id, organization_id)
    references teams (id, organization_id) on delete cascade;
--> statement-breakpoint
alter table bookings
  add constraint bookings_staff_fk foreign key (staff_user_id, organization_id)
    references staff_profiles (user_id, organization_id);
--> statement-breakpoint
alter table bookings
  add constraint bookings_customer_fk foreign key (organization_id, customer_id)
    references customers (organization_id, id);
--> statement-breakpoint
alter table bookings
  add constraint bookings_service_fk foreign key (organization_id, service_id)
    references services (organization_id, id);
--> statement-breakpoint
-- THE guarantee (spec 3.3). Application-level checking cannot get here: two
-- requests can both read "free" before either writes.
create extension if not exists btree_gist;
--> statement-breakpoint
-- btree_gist is what lets the plain equality on staff_user_id sit in a GiST
-- index alongside the range. '[)' bounds are load-bearing: a 10:00-11:00 and
-- an 11:00-12:00 appointment share an endpoint and must NOT collide. The
-- partial WHERE is what makes cancelling release the slot (spec 2.2).
--
-- Time off is deliberately outside this: blocks live in staff_time_off and are
-- applied as a filter in available_slots alongside existing bookings -- one
-- filter, because a block and an appointment are the same kind of busy period.
-- Sharing the constraint would mean a block carrying a customer, a service and
-- a price it does not have.
alter table bookings add constraint bookings_no_overlap
  exclude using gist (
    staff_user_id with =,
    tsrange(starts_at, ends_at, '[)') with &&
  ) where (status in ('pending', 'confirmed'));
--> statement-breakpoint
alter table bookings enable row level security;
