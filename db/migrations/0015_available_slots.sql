-- Which start times can this service be booked at, on this date, at this
-- branch?
--
-- In SQL for the reason staff_working_hours and service_branch_pricing are:
-- the booking path and the check suite exercise THE SAME logic, instead of the
-- tests re-implementing it and proving only that the copy works.
--
-- One row per bookable start per stylist. "Any available" is the DISTINCT
-- starts of that result -- the stylist is chosen at booking time, not here
-- (spec 2.4).
--
-- Deliberately NOT here: dropping starts in the past. That lives in
-- lib/booking.ts, the single module both callers route through, so this stays
-- pure over its arguments and neither caller can forget it (spec 4).
create or replace function available_slots(
  p_organization_id text,
  p_team_id text,
  p_service_id text,
  p_date date,
  p_staff_user_id text default null
) returns table (starts_at timestamp, staff_user_id text)
language sql stable as $$
  -- No row when the service is not offered at this branch, which already folds
  -- in the service's own `active` flag. The cross joins below then yield
  -- nothing at all, rather than slots for a service nobody sells here.
  with svc as (
    select p.duration_minutes
      from service_branch_pricing p
     where p.service_id = p_service_id
       and p.team_id = p_team_id
       and p.organization_id = p_organization_id
       and p.offered
  ),
  grid as (
    select s.slot_minutes from salon_profiles s
     where s.organization_id = p_organization_id
  ),
  -- Linked to the service, at this branch, active. Narrowed to one when a
  -- stylist was named; left wide for "any available".
  qualified as (
    select sp.user_id
      from service_staff ss
      join staff_profiles sp
        on sp.user_id = ss.user_id
       and sp.organization_id = ss.organization_id
     where ss.service_id = p_service_id
       and ss.organization_id = p_organization_id
       and sp.team_id = p_team_id
       and sp.active
       and (p_staff_user_id is null or sp.user_id = p_staff_user_id)
  ),
  candidates as (
    select q.user_id,
           gs.ts::timestamp as starts_at,
           (gs.ts + make_interval(mins => svc.duration_minutes))::timestamp as ends_at
      from qualified q
      cross join svc
      cross join grid
      -- ITERATES the set. staff_working_hours can only yield zero or one row
      -- today; this is the caller its set-returning signature was written for
      -- (scheduling spec 2.4), so multiple intervals per weekday later is a
      -- schema change with no change here.
      cross join lateral staff_working_hours(q.user_id, p_organization_id, p_date) wh
      -- Starts step from the interval's OPENING TIME, not from midnight: a
      -- 45-minute grid on a 09:00 open gives 09:00, 09:45, 10:30, which is
      -- what a salon expects to read (spec 2.3).
      --
      -- Stopping at (close - duration) is what makes the service fit ENTIRELY:
      -- a 90-minute service simply stops being offered after 19:30 against a
      -- 21:00 close, and an interval shorter than the service yields a stop
      -- before its start, so generate_series returns nothing.
      cross join lateral generate_series(
        p_date + wh.opens_at,
        p_date + wh.closes_at - make_interval(mins => svc.duration_minutes),
        make_interval(mins => grid.slot_minutes)
      ) gs(ts)
  )
  select c.starts_at, c.user_id
    from candidates c
   -- A time-off block and an existing appointment are the same kind of busy
   -- period, so this is one filter over two sources (spec 2.3 of scheduling).
   -- '[)' on both sides, matching bookings_no_overlap: a candidate ending
   -- exactly when a booking starts does not overlap it.
   where not exists (
     select 1 from bookings b
      where b.staff_user_id = c.user_id
        and b.organization_id = p_organization_id
        and b.status in ('pending', 'confirmed')
        and tsrange(b.starts_at, b.ends_at, '[)')
         && tsrange(c.starts_at, c.ends_at, '[)')
   )
     and not exists (
     select 1 from staff_time_off t
      where t.user_id = c.user_id
        and t.organization_id = p_organization_id
        and t.on_date = p_date
        and tsrange(p_date + t.starts_at, p_date + t.ends_at, '[)')
         && tsrange(c.starts_at, c.ends_at, '[)')
   )
   order by c.starts_at, c.user_id;
$$;
