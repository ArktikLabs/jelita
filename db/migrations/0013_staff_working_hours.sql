-- When is this stylist available on this date?
--
-- In SQL rather than TypeScript for the same reason service_branch_pricing is
-- a view: booking and the check suite then exercise THE SAME logic, instead of
-- the tests re-implementing it and proving only that the copy works.
--
-- Returns a SET even though it can only ever yield zero or one row today
-- (spec 2.4). That costs a loop which runs once, and it means adding multiple
-- intervals per weekday later is a schema change plus editing UI with NO
-- caller changes -- slot generation, the piece carrying the demo, is never
-- touched twice. Do not "simplify" this to a scalar before that option is
-- spent.
--
-- Time off is deliberately NOT subtracted here. This answers "when is this
-- person working?"; a block is a busy period, applied by booking in the same
-- filter as existing appointments. Folding it in would force this function to
-- return windows, which is the shape the set-returning signature exists to
-- defer.
create or replace function staff_working_hours(
  p_user_id text,
  p_organization_id text,
  p_date date
) returns table (opens_at time, closes_at time)
language sql
stable
as $$
  with person as (
    -- A deactivated staff member is not available, and one with no branch has
    -- no hours at all -- owners and admins carry team_id null by the staff
    -- model, so they are not bookable (a known gap, staff spec 8).
    select p.team_id
      from staff_profiles p
     where p.user_id = p_user_id
       and p.organization_id = p_organization_id
       and p.active
       and p.team_id is not null
  ),
  branch as (
    -- Nobody works when the branch is shut, whatever their own schedule says.
    select bh.closed, bh.opens_at, bh.closes_at
      from person
      join branch_hours bh
        on bh.team_id = person.team_id
       and bh.weekday = extract(dow from p_date)::smallint
  ),
  own as (
    -- An exception REPLACES the pattern for that date.
    --
    -- Chosen row-wise rather than per-column coalesce. Verified by breaking
    -- it: the two are currently EQUIVALENT, because staff_exception_times
    -- guarantees an open exception carries hours, so a coalesce can never pull
    -- the pattern's hours into an open day. The row-wise form is kept because
    -- it does not silently depend on that constraint holding -- but it is
    -- defensive, not load-bearing, and no assertion can tell the two apart.
    -- The constraint is what protects this; it is asserted directly.
    select case when e.user_id is not null then e.closed    else h.closed    end as closed,
           case when e.user_id is not null then e.opens_at  else h.opens_at  end as opens_at,
           case when e.user_id is not null then e.closes_at else h.closes_at end as closes_at
      from staff_hours h
      left join staff_schedule_exceptions e
        on e.user_id = h.user_id
       and e.organization_id = h.organization_id
       and e.on_date = p_date
     where h.user_id = p_user_id
       and h.organization_id = p_organization_id
       and h.weekday = extract(dow from p_date)::smallint
  )
  select greatest(own.opens_at, branch.opens_at),
         least(own.closes_at, branch.closes_at)
    from own
    cross join branch
   where not own.closed
     and not branch.closed
     -- Clamped at both ends, and an empty intersection yields no row rather
     -- than a negative-length one.
     and greatest(own.opens_at, branch.opens_at)
       < least(own.closes_at, branch.closes_at);
$$;
