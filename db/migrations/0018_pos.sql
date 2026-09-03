CREATE TABLE "transaction_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"transaction_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"service_id" text NOT NULL,
	"staff_user_id" text,
	"name" text NOT NULL,
	"unit_price" bigint NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"discount" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transaction_payments" (
	"id" text PRIMARY KEY NOT NULL,
	"transaction_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"method" text NOT NULL,
	"amount" bigint NOT NULL,
	"provider" text DEFAULT 'manual' NOT NULL,
	"provider_ref" text,
	"status" text DEFAULT 'settled' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"team_id" text NOT NULL,
	"customer_id" text,
	"booking_id" text,
	"status" text DEFAULT 'open' NOT NULL,
	"reverses_id" text,
	"subtotal" bigint DEFAULT 0 NOT NULL,
	"discount" bigint DEFAULT 0 NOT NULL,
	"total" bigint DEFAULT 0 NOT NULL,
	"currency" char(3) NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_org_id" UNIQUE("organization_id","id"),
	CONSTRAINT "transactions_reverses" UNIQUE("reverses_id")
);
--> statement-breakpoint
ALTER TABLE "salon_profiles" ADD COLUMN "logo_key" text;--> statement-breakpoint
ALTER TABLE "salon_profiles" ADD COLUMN "logo_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "salon_profiles" ADD COLUMN "brand_color" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transaction_lines_txn_idx" ON "transaction_lines" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "transaction_payments_txn_idx" ON "transaction_payments" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "transactions_day_idx" ON "transactions" USING btree ("organization_id","team_id","completed_at");--> statement-breakpoint
alter table transactions add constraint transactions_status
  check (status in ('open', 'completed', 'reversal'));
--> statement-breakpoint
-- Reversals are negative by design (spec 2.2), everything else cannot be. A
-- discount larger than the subtotal is therefore unrepresentable rather than
-- merely validated.
alter table transactions add constraint transactions_total_sign
  check (status = 'reversal' or total >= 0);
--> statement-breakpoint
alter table transactions add constraint transactions_discount_nonneg
  check (status = 'reversal' or (subtotal >= 0 and discount >= 0));
--> statement-breakpoint
-- One booking cannot be charged twice. Partial, so the reversal of a booking's
-- sale does not count as a second charge against it.
create unique index transactions_one_per_booking
  on transactions (booking_id) where booking_id is not null and status <> 'reversal';
--> statement-breakpoint
alter table transaction_lines add constraint transaction_lines_quantity
  check (quantity > 0);
--> statement-breakpoint
alter table transaction_payments add constraint transaction_payments_method
  check (method in ('cash', 'transfer', 'qris', 'debit', 'credit'));
--> statement-breakpoint
-- Cross-tenant rows are UNREPRESENTABLE, not merely filtered -- every target
-- already carries the matching unique constraint (spec 3.5).
alter table transactions
  add constraint transactions_team_fk foreign key (team_id, organization_id)
    references teams (id, organization_id) on delete cascade;
--> statement-breakpoint
alter table transactions
  add constraint transactions_customer_fk foreign key (organization_id, customer_id)
    references customers (organization_id, id);
--> statement-breakpoint
-- bookings never needed this until now: nothing referenced it. Added here
-- rather than back-dated into 0014, because a migration that has run is
-- history.
alter table bookings add constraint bookings_org_id unique (organization_id, id);
--> statement-breakpoint
alter table transactions
  add constraint transactions_booking_fk foreign key (organization_id, booking_id)
    references bookings (organization_id, id);
--> statement-breakpoint
alter table transactions
  add constraint transactions_reverses_fk foreign key (reverses_id)
    references transactions (id);
--> statement-breakpoint
alter table transaction_lines
  add constraint transaction_lines_txn_fk
    foreign key (organization_id, transaction_id)
    references transactions (organization_id, id) on delete cascade;
--> statement-breakpoint
alter table transaction_lines
  add constraint transaction_lines_service_fk
    foreign key (organization_id, service_id) references services (organization_id, id);
--> statement-breakpoint
alter table transaction_payments
  add constraint transaction_payments_txn_fk
    foreign key (organization_id, transaction_id)
    references transactions (organization_id, id) on delete cascade;
--> statement-breakpoint
-- White-label (PRD 7): #rrggbb or nothing. A colour that reaches a stylesheet
-- unvalidated is a CSS injection on the public booking page.
alter table salon_profiles add constraint salon_profiles_brand_color
  check (brand_color is null or brand_color ~ '^#[0-9a-fA-F]{6}$');
--> statement-breakpoint
-- THE guarantee (spec 2.1). "Immutable after completion" is enforced here and
-- not in application code, for the same reason bookings_no_overlap is: code
-- can forget, and the code most likely to forget has not been written yet. A
-- report, a migration, an admin fix at 2am -- all of them meet this wall.
--
-- open -> completed is the LAST write a transaction receives. Voiding writes a
-- new row; it never touches the original.
create or replace function refuse_settled_write() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'transaction % is settled and cannot be deleted', old.id
      using errcode = 'restrict_violation';
  end if;
  raise exception 'transaction % is settled and cannot be changed', old.id
    using errcode = 'restrict_violation';
end;
$$;
--> statement-breakpoint
-- WHEN, not an `if` inside the function: the condition is part of the trigger
-- so Postgres skips the call entirely for open rows, and the rule is visible
-- in \d output rather than buried in a function body.
create trigger transactions_settled_immutable
  before update or delete on transactions
  for each row when (old.status <> 'open')
  execute function refuse_settled_write();
--> statement-breakpoint
-- Lines follow their parent: editing a completed sale's lines would rewrite
-- the receipt without touching the row the trigger above guards.
create or replace function refuse_settled_line_write() returns trigger
language plpgsql as $$
declare
  parent_status text;
begin
  select t.status into parent_status from transactions t
   where t.id = coalesce(old.transaction_id, new.transaction_id);
  if parent_status is not null and parent_status <> 'open' then
    raise exception 'transaction % is settled; its lines cannot change',
      coalesce(old.transaction_id, new.transaction_id)
      using errcode = 'restrict_violation';
  end if;
  return coalesce(new, old);
end;
$$;
--> statement-breakpoint
create trigger transaction_lines_settled_immutable
  before insert or update or delete on transaction_lines
  for each row execute function refuse_settled_line_write();
--> statement-breakpoint
create trigger transaction_payments_settled_immutable
  before insert or update or delete on transaction_payments
  for each row execute function refuse_settled_line_write();
--> statement-breakpoint
alter table transactions enable row level security;
--> statement-breakpoint
alter table transaction_lines enable row level security;
--> statement-breakpoint
alter table transaction_payments enable row level security;
