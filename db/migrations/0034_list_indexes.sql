-- Every column a list spec declares sortable (§3.2) needs an index behind
-- it, or ordering a tenant's own rows becomes a sequential scan. `id` trails
-- each one so the tiebreak the ORDER BY always appends (§3.3) is served by
-- the same index, not a separate sort step.

-- products.price: nullable (an internal-use product carries none). Sorted
-- with `nulls last` in BOTH directions by PRODUCT_LIST (lib/inventory.ts),
-- so this index primarily earns its keep by letting the planner narrow to
-- one tenant's rows before sorting -- see that spec's comment for why a
-- plain btree cannot serve both directions as an exact scan once nulls are
-- involved.
create index products_org_price_idx on products (organization_id, price, id);

-- services.price: never null, so this one IS an exact match for both
-- directions.
create index services_org_price_idx on services (organization_id, price, id);

-- teams.name, for the branches list. teams had only (organization_id)
-- before this (0000_goofy_layla_miller.sql).
create index teams_org_name_idx on teams (organization_id, name, id);
