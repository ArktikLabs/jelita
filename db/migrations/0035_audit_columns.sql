-- Actors, on the tables a person edits. NULLABLE and NOT defaulted: a public
-- booking, the seed script and the cron all write without a signed-in user,
-- and NULL there means "not created by a person" rather than "we forgot".
alter table customers  add column created_by text references users (id) on delete set null;
alter table customers  add column updated_by text references users (id) on delete set null;
alter table products   add column created_by text references users (id) on delete set null;
alter table products   add column updated_by text references users (id) on delete set null;
alter table services   add column created_by text references users (id) on delete set null;
alter table services   add column updated_by text references users (id) on delete set null;
alter table staff_profiles  add column created_by text references users (id) on delete set null;
alter table staff_profiles  add column updated_by text references users (id) on delete set null;
alter table branch_profiles add column created_by text references users (id) on delete set null;
alter table branch_profiles add column updated_by text references users (id) on delete set null;
--> statement-breakpoint
-- Transactions get created_by and NOTHING else. A settled row is immutable by
-- trigger, so updated_by could never be written -- and who voided a sale is
-- already recorded: the reversal is its own row with its own created_by.
alter table transactions add column created_by text references users (id) on delete set null;
--> statement-breakpoint
-- `deleted_at` records WHEN a record stopped being offered, and `deleted_by`
-- by whom. It does NOT mean "hide this row": `active` remains the single
-- truth for that, and a deactivated stylist must still appear in the payroll
-- for a month they worked (spec §5.1).
alter table customers add column deleted_at timestamp with time zone;
alter table customers add column deleted_by text references users (id) on delete set null;
alter table products  add column deleted_at timestamp with time zone;
alter table products  add column deleted_by text references users (id) on delete set null;
alter table services  add column deleted_at timestamp with time zone;
alter table services  add column deleted_by text references users (id) on delete set null;
--> statement-breakpoint
-- These two already carry the concept under the old name. RENAME rather than
-- add, so one concept keeps one name across the schema.
alter table staff_profiles  rename column deactivated_at to deleted_at;
alter table branch_profiles rename column deactivated_at to deleted_at;
alter table staff_profiles  add column deleted_by text references users (id) on delete set null;
alter table branch_profiles add column deleted_by text references users (id) on delete set null;
--> statement-breakpoint
-- Nothing maintained updated_at before this: 31 call sites set it by hand and
-- any new one could forget. A trigger is the only version of this column that
-- can be trusted, which is what makes it worth reading.
create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;
--> statement-breakpoint
create trigger customers_touch_updated_at       before update on customers       for each row execute function touch_updated_at();
create trigger products_touch_updated_at        before update on products        for each row execute function touch_updated_at();
create trigger services_touch_updated_at        before update on services        for each row execute function touch_updated_at();
create trigger staff_profiles_touch_updated_at  before update on staff_profiles  for each row execute function touch_updated_at();
create trigger branch_profiles_touch_updated_at before update on branch_profiles for each row execute function touch_updated_at();
