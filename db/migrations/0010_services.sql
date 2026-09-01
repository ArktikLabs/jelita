CREATE TABLE "salon_profiles" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"currency" char(3) DEFAULT 'IDR' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_branch_overrides" (
	"service_id" text NOT NULL,
	"team_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"price" bigint,
	"offered" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_categories" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_categories_org_id" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "service_staff" (
	"service_id" text NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"category_id" text,
	"name" text NOT NULL,
	"duration_minutes" smallint NOT NULL,
	"price" bigint NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "services_org_id" UNIQUE("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "salon_profiles" ADD CONSTRAINT "salon_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_categories" ADD CONSTRAINT "service_categories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "services_org_idx" ON "services" USING btree ("organization_id");--> statement-breakpoint
-- A composite FK needs a unique constraint on the columns it references.
-- teams carries only PRIMARY KEY (id) today, so this adds the pair. It is
-- redundant against that primary key and therefore cannot reject a row
-- better-auth would otherwise write; it exists purely to be referenceable.
alter table teams add constraint teams_id_organization_id_unique
  unique (id, organization_id);
--> statement-breakpoint
alter table service_branch_overrides
  add constraint service_branch_overrides_pkey primary key (service_id, team_id);
--> statement-breakpoint
-- Cross-tenant rows are UNREPRESENTABLE, not merely filtered. An override
-- pointing at another salon's branch cannot be stored at all, rather than
-- being something every query must remember to exclude.
alter table service_branch_overrides
  add constraint sbo_service_fk foreign key (service_id, organization_id)
    references services (id, organization_id) on delete cascade,
  add constraint sbo_team_fk foreign key (team_id, organization_id)
    references teams (id, organization_id) on delete cascade;
--> statement-breakpoint
alter table service_staff
  add constraint service_staff_pkey primary key (service_id, user_id);
--> statement-breakpoint
-- staff_profiles, not members: it already carries unique (user_id,
-- organization_id) from the staff feature, and "a staff member of this salon"
-- is the more accurate target. Adding a unique to members would forbid a
-- second membership row that better-auth does not itself forbid.
alter table service_staff
  add constraint service_staff_service_fk foreign key (service_id, organization_id)
    references services (id, organization_id) on delete cascade,
  add constraint service_staff_person_fk foreign key (user_id, organization_id)
    references staff_profiles (user_id, organization_id) on delete cascade;
--> statement-breakpoint
alter table services
  add constraint services_category_fk foreign key (category_id, organization_id)
    references service_categories (id, organization_id) on delete set null;
--> statement-breakpoint
alter table services add constraint services_duration_positive
  check (duration_minutes > 0);
--> statement-breakpoint
alter table services add constraint services_price_nonnegative
  check (price >= 0);
--> statement-breakpoint
alter table service_branch_overrides add constraint sbo_price_nonnegative
  check (price is null or price >= 0);
--> statement-breakpoint
-- A duplicate name inside one salon is a 409. Case-insensitive, because
-- "Potong Rambut" and "potong rambut" are the same thing to a receptionist.
create unique index services_org_name_lower
  on services (organization_id, lower(name));
--> statement-breakpoint
-- Every salon gets settings, seeded the way branch_profiles and
-- staff_profiles are. IDR is the default because that is the launch market.
create or replace function seed_salon_profile() returns trigger
language plpgsql as $$
begin
  insert into salon_profiles (organization_id) values (new.id)
  on conflict (organization_id) do nothing;
  return new;
end $$;
--> statement-breakpoint
create trigger organizations_seed_salon_profile
  after insert on organizations
  for each row execute function seed_salon_profile();
--> statement-breakpoint
insert into salon_profiles (organization_id)
select o.id from organizations o
  left join salon_profiles p on p.organization_id = o.id
 where p.organization_id is null;
--> statement-breakpoint
-- ONE resolution, read by both the app and the check suite, so the coalesce
-- cannot be copy-pasted into three versions that drift. security_invoker
-- matches the branch_entitlement precedent.
create view service_branch_pricing with (security_invoker = true) as
select s.id as service_id, t.id as team_id, s.organization_id,
       coalesce(o.price, s.price) as price,
       (s.active and coalesce(o.offered, true)) as offered,
       s.duration_minutes, p.currency
  from services s
  join teams t on t.organization_id = s.organization_id
  join salon_profiles p on p.organization_id = s.organization_id
  left join service_branch_overrides o
    on o.service_id = s.id and o.team_id = t.id;
--> statement-breakpoint
alter table salon_profiles enable row level security;
--> statement-breakpoint
alter table service_categories enable row level security;
--> statement-breakpoint
alter table services enable row level security;
--> statement-breakpoint
alter table service_branch_overrides enable row level security;
--> statement-breakpoint
alter table service_staff enable row level security;
