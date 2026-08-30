-- Views default to security-definer semantics: they read their base tables as
-- the view OWNER, so effective_plan and branch_entitlement would hand any role
-- holding `select` on them (Supabase grants that to anon/authenticated on new
-- public objects) the contents of organizations, teams, subscriptions and
-- plans AROUND the RLS on those tables. security_invoker makes the caller's
-- own privileges and policies apply.
create or replace view effective_plan with (security_invoker = true) as
select o.id as organization_id,
       coalesce(
         case when s.status = 'canceled' then null else s.plan_id end,
         (select id from plans where is_default)
       ) as plan_id
  from organizations o
  left join subscriptions s on s.organization_id = o.id;

create or replace view branch_entitlement with (security_invoker = true) as
with ranked as (
  select t.id, t.organization_id,
         row_number() over (partition by t.organization_id
                            order by t.created_at, t.id) as seq
    from teams t
)
select r.id as team_id, r.organization_id, r.seq, l.cap,
       (l.cap is null or r.seq <= l.cap) as is_active
  from ranked r
  join effective_plan e on e.organization_id = r.organization_id
  left join plan_limits l
    on l.plan_id = e.plan_id and l.resource = 'branches';

-- RLS with no policy = deny all. The app connects as the table owner (which
-- bypasses RLS), so this costs the app nothing and closes the anon key off.
-- Asserted by scripts/plan-check.mjs — but until now that assertion held on a
-- property of one Supabase project rather than of these migrations.
alter table features enable row level security;
alter table plans enable row level security;
alter table plan_limits enable row level security;
alter table plan_features enable row level security;
alter table subscriptions enable row level security;
