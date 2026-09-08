-- `created` is declared sortable on the customer list, and §3.2 of the list
-- spec makes that a promise the column is cheap to order by. Without this,
-- sorting a tenant's customers by newest is a sequential scan on every page.
create index customers_org_created_idx on customers (organization_id, created_at desc, id);
