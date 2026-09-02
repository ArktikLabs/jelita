-- Is this member's position tied to a branch, so that closing it strands them?
--
-- `members.role` is a comma-separated list (better-auth splits it on ',' in
-- hasPermissionFn), so a member may hold several roles and the union applies.
-- Split-and-trim rather than LIKE: LIKE '%admin%' would also swallow a custom
-- role named 'branch-admin-assistant', and this predicate decides whether a
-- branch can be closed out from under someone.
--
-- A DENY-LIST on the salon-wide roles, not an allow-list on {stylist,
-- frontdesk} -- the opposite of ASSIGNABLE_ROLES in lib/permissions.ts, and
-- for the same underlying reason: pick the conservative failure.
--
--   * There, an unknown role must not silently gain privileges, so nothing is
--     granted unless it is on the list.
--   * Here, an unknown role must not silently LOSE its branch. dynamicAccessControl
--     lets a salon define 'manajer' or 'senior stylist' at runtime, and an
--     allow-list would let a branch close under one of them without warning.
--     A deny-list at worst makes a branch harder to close, which is a nuisance;
--     the allow-list version strands staff, which is a bug.
--
-- Owner and admin are the salon-wide pair. They carry a team_id now -- it
-- answers "works here", which is what makes a working owner bookable -- but
-- they are not stranded by closing a branch they run, and counting them would
-- make a salon whose owner works the floor unable to close that branch at all.
-- A NULL or empty role is unknown, and unknown is treated as stationed.
create or replace function is_stationed(p_role text) returns boolean
language sql immutable as $$
  -- The null/empty case is spelled out rather than left to the exists below:
  -- string_to_array('', ',') is an EMPTY array, not an array holding one empty
  -- string, so the exists would return false -- treating "no role at all" as
  -- salon-wide, the opposite of the conservative default above.
  select p_role is null or btrim(p_role) = '' or exists (
    select 1 from unnest(string_to_array(p_role, ',')) r
     where trim(r) not in ('owner', 'admin')
  );
$$;
