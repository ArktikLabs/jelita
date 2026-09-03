CREATE TABLE "customer_points" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"transaction_id" text NOT NULL,
	"points" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_points_one_per_sale" UNIQUE("transaction_id")
);
--> statement-breakpoint
ALTER TABLE "salon_profiles" ADD COLUMN "points_per_unit" integer;--> statement-breakpoint
ALTER TABLE "customer_points" ADD CONSTRAINT "customer_points_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_points_balance_idx" ON "customer_points" USING btree ("organization_id","customer_id");--> statement-breakpoint
-- Zero would be a division by zero, not a business rule.
alter table salon_profiles add constraint salon_profiles_points_per_unit
  check (points_per_unit is null or points_per_unit > 0);
--> statement-breakpoint
-- A zero-point row records nothing and would only ever be a bug leaking into
-- the ledger.
alter table customer_points add constraint customer_points_nonzero
  check (points <> 0);
--> statement-breakpoint
alter table customer_points
  add constraint customer_points_customer_fk foreign key (organization_id, customer_id)
    references customers (organization_id, id) on delete cascade;
--> statement-breakpoint
alter table customer_points
  add constraint customer_points_txn_fk foreign key (organization_id, transaction_id)
    references transactions (organization_id, id) on delete cascade;
--> statement-breakpoint
-- Points hang off a settled transaction, so they follow the same rule its
-- lines do: writable while the parent is open, refused after. The function
-- already exists (0018) -- this attaches it to one more table rather than
-- restating the rule.
create trigger customer_points_settled_immutable
  before insert or update or delete on customer_points
  for each row execute function refuse_settled_line_write();
--> statement-breakpoint
alter table customer_points enable row level security;
