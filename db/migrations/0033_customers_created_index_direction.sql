-- The tiebreak now takes the sort's direction, so the emitted order is
-- `created_at desc, id desc` or `created_at asc, id asc` -- never mixed. A
-- plain (organization_id, created_at, id) btree is an exact match for both:
-- forward for ascending, backward for descending. The old mixed-direction
-- index served only one of them.
drop index if exists customers_org_created_idx;
create index customers_org_created_idx on customers (organization_id, created_at, id);
