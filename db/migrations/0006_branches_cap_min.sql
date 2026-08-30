-- A salon tier with zero branches is not a product, and configuring one breaks
-- signup in a way that is hard to see coming: better-auth fires
-- beforeCreateTeam for the default team it auto-creates during organization
-- creation, so a `branches` cap of 0 would fail signup AFTER the organization
-- and owner-member rows are committed and BEFORE the default team is made,
-- leaving an orphan salon with an owner and no branch.
--
-- Tiers are authored as data by a separate internal app, so a code comment is
-- the weakest possible guard against the person who will actually hit this.
-- Make the configuration unrepresentable instead.
--
-- Only `branches` is constrained: it is the one on the signup critical path.
-- A cap of 0 remains legitimate elsewhere (e.g. `products` on a tier sold
-- without the inventory feature).
alter table plan_limits add constraint plan_limits_branches_min
  check (resource <> 'branches' or cap >= 1);
