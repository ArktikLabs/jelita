-- The staff seat cap, enforced in the database.
--
-- requireQuota counts seats and then the caller creates one, and two creates
-- at `used = cap - 1` both pass. Like the ownerless-salon race, the
-- application cannot close it: better-auth's addMember writes the members row
-- through its own adapter, so no application transaction covers both the count
-- and the write.
--
-- Same shape as refuse_ownerless_salon (0025), and for the same reason
-- learned there: `for update` on the organization row FIRST, so two
-- concurrent creates contend rather than each counting a snapshot that
-- excludes the other. Deferring without the lock lets both through.
--
-- Deliberately NOT deferred: a seat that is over the cap should fail at the
-- statement that created it, so the error names the insert that caused it.
-- The ownerless guard is deferred because a legitimate transaction passes
-- through an ownerless moment; nothing legitimate passes through an over-cap
-- moment.
create or replace function refuse_over_seat_cap() returns trigger
language plpgsql as $$
declare
  seat_cap int;
  used int;
begin
  perform 1 from organizations where id = new.organization_id for update;
  if not found then
    return new;
  end if;

  select l.cap into seat_cap
    from effective_plan e
    join plan_limits l on l.plan_id = e.plan_id and l.resource = 'staff'
   where e.organization_id = new.organization_id;
  -- No plan_limits row means unlimited, exactly as requireQuota reads it.
  if seat_cap is null then
    return new;
  end if;

  -- Counted the way countResource does: a member with no profile row still
  -- holds a seat, because a missing row must never hand out a free one.
  select count(*) into used
    from members m
   where m.organization_id = new.organization_id
     and coalesce((select s.active from staff_profiles s
                    where s.user_id = m.user_id
                      and s.organization_id = m.organization_id), true);

  if used > seat_cap then
    raise exception 'salon % is over its staff cap (% of %)',
      new.organization_id, used, seat_cap
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create constraint trigger members_within_seat_cap
  after insert on members
  for each row execute function refuse_over_seat_cap();
