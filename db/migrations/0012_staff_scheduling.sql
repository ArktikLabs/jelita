CREATE TABLE "staff_hours" (
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"weekday" smallint NOT NULL,
	"closed" boolean DEFAULT false NOT NULL,
	"opens_at" time DEFAULT '09:00' NOT NULL,
	"closes_at" time DEFAULT '21:00' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_hours_user_id_organization_id_weekday_pk" PRIMARY KEY("user_id","organization_id","weekday")
);
--> statement-breakpoint
CREATE TABLE "staff_schedule_exceptions" (
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"on_date" date NOT NULL,
	"closed" boolean DEFAULT true NOT NULL,
	"opens_at" time,
	"closes_at" time,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_schedule_exceptions_user_id_organization_id_on_date_pk" PRIMARY KEY("user_id","organization_id","on_date")
);
--> statement-breakpoint
CREATE TABLE "staff_time_off" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"on_date" date NOT NULL,
	"starts_at" time NOT NULL,
	"ends_at" time NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "staff_hours" ADD CONSTRAINT "staff_hours_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_schedule_exceptions" ADD CONSTRAINT "staff_schedule_exceptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_time_off" ADD CONSTRAINT "staff_time_off_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Same shape as branch_hours' constraint: a closed day needs no valid interval.
alter table staff_hours add constraint staff_hours_times
  check (closed or closes_at > opens_at);
--> statement-breakpoint
alter table staff_hours add constraint staff_hours_weekday_range
  check (weekday between 0 and 6);
--> statement-breakpoint
-- An open exception must carry real hours; a closed one need not.
alter table staff_schedule_exceptions add constraint staff_exception_times
  check (closed or (opens_at is not null and closes_at is not null
                    and closes_at > opens_at));
--> statement-breakpoint
alter table staff_time_off add constraint staff_time_off_times
  check (ends_at > starts_at);
--> statement-breakpoint
-- Cross-tenant rows are UNREPRESENTABLE, not merely filtered: staff_profiles
-- already carries unique (user_id, organization_id), so these reference the
-- pair rather than the user alone. The database refuses the row instead of
-- every query having to remember.
alter table staff_hours
  add constraint staff_hours_person_fk foreign key (user_id, organization_id)
    references staff_profiles (user_id, organization_id) on delete cascade;
--> statement-breakpoint
alter table staff_schedule_exceptions
  add constraint staff_exception_person_fk foreign key (user_id, organization_id)
    references staff_profiles (user_id, organization_id) on delete cascade;
--> statement-breakpoint
alter table staff_time_off
  add constraint staff_time_off_person_fk foreign key (user_id, organization_id)
    references staff_profiles (user_id, organization_id) on delete cascade;
--> statement-breakpoint
create index staff_time_off_lookup
  on staff_time_off (user_id, organization_id, on_date);
--> statement-breakpoint
-- A new hire is bookable immediately. An unconfigured schedule that silently
-- means "never appears in booking" is a failure nobody sees: the stylist is
-- simply never booked and no error is ever raised (spec 2.5).
create or replace function seed_staff_hours() returns trigger
language plpgsql as $$
begin
  insert into staff_hours (user_id, organization_id, weekday)
  select new.user_id, new.organization_id, generate_series(0, 6)
  on conflict do nothing;
  return new;
end $$;
--> statement-breakpoint
create trigger staff_profiles_seed_hours
  after insert on staff_profiles
  for each row execute function seed_staff_hours();
--> statement-breakpoint
insert into staff_hours (user_id, organization_id, weekday)
select p.user_id, p.organization_id, d.weekday
  from staff_profiles p
  cross join generate_series(0, 6) as d(weekday)
  left join staff_hours h
    on h.user_id = p.user_id and h.organization_id = p.organization_id
   and h.weekday = d.weekday
 where h.user_id is null;
--> statement-breakpoint
alter table staff_hours enable row level security;
--> statement-breakpoint
alter table staff_schedule_exceptions enable row level security;
--> statement-breakpoint
alter table staff_time_off enable row level security;
