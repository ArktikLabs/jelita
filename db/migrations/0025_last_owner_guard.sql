-- A salon can never be left with zero ACTIVE owners.
--
-- This was a documented, accepted gap: the application checks the owner count
-- and then demotes, and two owners demoting each other in the same instant
-- both pass the check. The app cannot fix it -- better-auth's updateMemberRole
-- writes the members row on its OWN connection, so an application transaction
-- cannot wrap the check and the write together, and there is no shared lock
-- for the two callers to contend on.
--
-- A DEFERRABLE constraint trigger can. It fires at COMMIT rather than at
-- statement time, and under READ COMMITTED its query takes a fresh snapshot
-- then -- so whichever transaction commits second sees the first one's demote
-- and is refused. The salon keeps an owner and the loser is told to retry.
--
-- Deferred also matters for legitimate multi-step work: a transaction that
-- demotes one owner and promotes another passes, because only the end state is
-- checked.
--
-- Covers every path, not just the one screen: a script, a psql session and a
-- future feature all meet it.
create or replace function refuse_ownerless_salon() returns trigger
language plpgsql as $$
declare
  org text;
  owners int;
begin
  org := coalesce(new.organization_id, old.organization_id);

  -- LOCK THE ORGANIZATION ROW FIRST, and this is the whole fix.
  --
  -- Deferring alone is not enough: a deferred trigger takes its snapshot while
  -- the transaction is committing, so two commits happening at the same
  -- instant can each still see the other's owner and both pass. That is not
  -- theoretical -- an earlier version of this trigger without the lock let the
  -- demote-versus-demote race through, and the assertion that "caught" it in a
  -- second test file had merely serialised by luck of timing.
  --
  -- FOR UPDATE gives the two transactions something to contend on: the second
  -- blocks until the first commits, then counts against a snapshot that
  -- includes it.
  --
  -- It doubles as the existence check. Deleting the organization cascades into
  -- members, and a salon that no longer exists cannot be ownerless.
  perform 1 from organizations where id = org for update;
  if not found then
    return null;
  end if;

  select count(*) into owners
    from members m
    join staff_profiles s
      on s.user_id = m.user_id and s.organization_id = m.organization_id
   where m.organization_id = org
     and s.active
     and 'owner' = any (string_to_array(m.role, ','));

  if owners = 0 then
    raise exception 'salon % would be left with no active owner', org
      using errcode = 'restrict_violation';
  end if;
  return null;
end;
$$;
--> statement-breakpoint
-- On members: demotion (role no longer contains owner) and removal.
--
-- WHEN the role actually changed, not on every update: an AFTER UPDATE trigger
-- with no condition fires when an unrelated column moves, which is both
-- wasteful and surprising -- and it turns "this organization has no owner"
-- into an error raised by a write that had nothing to do with ownership.
create constraint trigger members_keep_an_owner
  after update on members
  deferrable initially deferred
  for each row when (old.role is distinct from new.role)
  execute function refuse_ownerless_salon();
--> statement-breakpoint
create constraint trigger members_removed_keep_an_owner
  after delete on members
  deferrable initially deferred
  for each row execute function refuse_ownerless_salon();
--> statement-breakpoint
-- On staff_profiles: deactivating the last owner is the same hole by another
-- door. deactivateStaffAction already guards it with a `for update of s, m`
-- lock set; this makes it structural rather than a property of one code path.
-- Likewise: only when `active` moves. A branch transfer is not an ownership
-- change and must not be refused as one.
create constraint trigger staff_profiles_keep_an_owner
  after update on staff_profiles
  deferrable initially deferred
  for each row when (old.active is distinct from new.active)
  execute function refuse_ownerless_salon();
