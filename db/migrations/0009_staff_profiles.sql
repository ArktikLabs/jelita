CREATE TABLE "staff_profiles" (
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"team_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"deactivated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_profiles_one_branch" UNIQUE("user_id","organization_id")
);
--> statement-breakpoint
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- Every member of a salon gets a profile, the owner included: the seat cap
-- counts members, so if only assigned staff had rows, owners and admins would
-- silently stop counting and every salon's effective allowance would jump.
-- The trigger cannot know a branch (better-auth's addMember writes the
-- team_members row separately), so it seeds team_id null and lib/staff.ts
-- fills it in.
create or replace function seed_staff_profile() returns trigger
language plpgsql as $$
begin
  insert into staff_profiles (user_id, organization_id)
  values (new.user_id, new.organization_id)
  on conflict (user_id, organization_id) do nothing;
  return new;
end $$;
--> statement-breakpoint
create trigger members_seed_staff_profile
  after insert on members
  for each row execute function seed_staff_profile();
--> statement-breakpoint
insert into staff_profiles (user_id, organization_id)
select m.user_id, m.organization_id from members m
  left join staff_profiles s
    on s.user_id = m.user_id and s.organization_id = m.organization_id
 where s.user_id is null;
--> statement-breakpoint
-- Carry existing assignments across. A non-management member with a
-- team_members row in this salon was working at that branch; losing that on
-- migration would silently empty every roster. Deterministic pick so the
-- migration is reproducible.
update staff_profiles s
   set team_id = (
     select tm.team_id from team_members tm
       join teams t on t.id = tm.team_id
      where tm.user_id = s.user_id and t.organization_id = s.organization_id
      order by tm.created_at, tm.team_id limit 1)
 where s.team_id is null
   and exists (
     select 1 from members m
      where m.user_id = s.user_id and m.organization_id = s.organization_id
        and not (string_to_array(m.role, ',') && array['owner', 'admin']));
--> statement-breakpoint
alter table staff_profiles enable row level security;