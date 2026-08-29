alter table features add constraint features_key_format
  check (key ~ '^[a-z_]+$');

alter table plans add constraint plans_key_format
  check (key ~ '^[a-z_]+$');
alter table plans add constraint plans_price_nonneg
  check (price_idr >= 0);
alter table plans add constraint plans_interval
  check (billing_interval in ('month','year'));
create unique index plans_one_default on plans (is_default) where is_default;

alter table plan_limits add constraint plan_limits_resource
  check (resource in ('branches','staff','services','products'));
alter table plan_limits add constraint plan_limits_cap_nonneg
  check (cap >= 0);

alter table subscriptions add constraint subscriptions_status
  check (status in ('trialing','active','past_due','canceled'));

-- Every tenant always has a subscription. A trigger, not an application
-- hook: a separate internal Arktik app will create organizations without
-- passing through this codebase.
create or replace function assign_default_plan() returns trigger
language plpgsql as $$
declare default_plan bigint;
begin
  select id into default_plan from plans where is_default limit 1;
  if default_plan is null then
    raise exception 'no default plan configured (plans.is_default)';
  end if;
  insert into subscriptions (organization_id, plan_id)
  values (new.id, default_plan);
  return new;
end $$;

create trigger organizations_assign_default_plan
  after insert on organizations
  for each row execute function assign_default_plan();

-- Canceled subscriptions fall back to the default plan, so cancellation
-- needs no dedicated code path.
create view effective_plan as
select o.id as organization_id,
       coalesce(
         case when s.status = 'canceled' then null else s.plan_id end,
         (select id from plans where is_default)
       ) as plan_id
  from organizations o
  left join subscriptions s on s.organization_id = o.id;

-- Lock state is computed, never stored: the oldest N branches survive.
-- The (created_at, id) tiebreak keeps ordering stable when seeded rows
-- share a timestamp.
create view branch_entitlement as
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
