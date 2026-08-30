alter table branch_hours add constraint branch_hours_weekday_range
  check (weekday between 0 and 6);
alter table branch_hours add constraint branch_hours_times
  check (closed or closes_at > opens_at);

-- A branch created by ANY path must be fully configured. better-auth creates
-- teams this codebase never sees: the organization plugin auto-creates a
-- default team during signup. Defaults are deliberately over-permissive —
-- an owner narrowing hours is routine, a branch that silently accepts no
-- bookings looks broken.
create or replace function seed_branch_defaults() returns trigger
language plpgsql as $$
begin
  insert into branch_profiles (team_id) values (new.id);
  insert into branch_hours (team_id, weekday)
  select new.id, generate_series(0, 6);
  return new;
end $$;

create trigger teams_seed_branch_defaults
  after insert on teams
  for each row execute function seed_branch_defaults();

-- Backfill teams that already exist.
insert into branch_profiles (team_id)
select t.id from teams t
  left join branch_profiles p on p.team_id = t.id
 where p.team_id is null;

insert into branch_hours (team_id, weekday)
select t.id, d.weekday
  from teams t
  cross join generate_series(0, 6) as d(weekday)
  left join branch_hours h on h.team_id = t.id and h.weekday = d.weekday
 where h.team_id is null;

-- Deactivation does not change billing (countResource still counts every
-- team), but a closed branch must not hold a slot that keeps a live one
-- locked: with cap 1 and an older deactivated branch, ranking all teams
-- would leave the only OPEN branch read-only. Rank active branches only.
--
-- `is_active` is also renamed to `within_cap`: branch_profiles.active means
-- "not deactivated", this column means "within the tier's cap", and the two
-- get joined together.
drop view if exists branch_entitlement;

create view branch_entitlement with (security_invoker = true) as
with ranked as (
  select t.id, t.organization_id,
         row_number() over (partition by t.organization_id
                            order by t.created_at, t.id) as seq
    from teams t
    join branch_profiles p on p.team_id = t.id
   where p.active
)
select r.id as team_id, r.organization_id, r.seq, l.cap,
       (l.cap is null or r.seq <= l.cap) as within_cap
  from ranked r
  join effective_plan e on e.organization_id = r.organization_id
  left join plan_limits l
    on l.plan_id = e.plan_id and l.resource = 'branches';

alter table branch_profiles enable row level security;
alter table branch_hours enable row level security;
