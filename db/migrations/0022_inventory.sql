CREATE TABLE "products" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"sku" text,
	"kind" text DEFAULT 'retail' NOT NULL,
	"price" bigint,
	"reorder_level" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_org_id" UNIQUE("organization_id","id"),
	CONSTRAINT "products_org_sku" UNIQUE("organization_id","sku")
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"team_id" text NOT NULL,
	"product_id" text NOT NULL,
	"quantity" integer NOT NULL,
	"reason" text NOT NULL,
	"actor_user_id" text,
	"transaction_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transaction_lines" ALTER COLUMN "service_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "transaction_lines" ADD COLUMN "kind" text DEFAULT 'service' NOT NULL;--> statement-breakpoint
ALTER TABLE "transaction_lines" ADD COLUMN "product_id" text;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "products_org_name_idx" ON "products" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "stock_movements_balance_idx" ON "stock_movements" USING btree ("organization_id","product_id","team_id");--> statement-breakpoint
alter table products add constraint products_kind
  check (kind in ('retail', 'internal'));
--> statement-breakpoint
-- A retail product has a price; an internal one is never sold, so a price on
-- it would be a number nobody ever charges.
alter table products add constraint products_price_for_kind
  check ((kind = 'retail' and price is not null and price >= 0)
      or (kind = 'internal' and price is null));
--> statement-breakpoint
alter table products add constraint products_reorder_nonneg
  check (reorder_level >= 0);
--> statement-breakpoint
alter table stock_movements add constraint stock_movements_reason
  check (reason in ('purchase', 'sale', 'usage', 'adjustment'));
--> statement-breakpoint
-- A zero movement records nothing and would only ever be a bug leaking into
-- the ledger.
alter table stock_movements add constraint stock_movements_quantity
  check (quantity <> 0);
--> statement-breakpoint
alter table stock_movements
  add constraint stock_movements_product_fk foreign key (organization_id, product_id)
    references products (organization_id, id) on delete cascade;
--> statement-breakpoint
alter table stock_movements
  add constraint stock_movements_team_fk foreign key (team_id, organization_id)
    references teams (id, organization_id) on delete cascade;
--> statement-breakpoint
alter table stock_movements
  add constraint stock_movements_txn_fk foreign key (organization_id, transaction_id)
    references transactions (organization_id, id) on delete cascade;
--> statement-breakpoint
-- Exactly one of service_id / product_id, and `kind` agreeing with whichever
-- it is. Without this a line could name both and every reader would have to
-- pick a precedence -- which is how two readers end up picking differently.
alter table transaction_lines add constraint transaction_lines_subject
  check ((kind = 'service' and service_id is not null and product_id is null)
      or (kind = 'product' and product_id is not null and service_id is null));
--> statement-breakpoint
alter table transaction_lines
  add constraint transaction_lines_product_fk foreign key (organization_id, product_id)
    references products (organization_id, id);
--> statement-breakpoint
-- APPEND-ONLY. Not for the reason transactions freeze after completion -- a
-- ledger has no `open` state to allow. A correction is another movement, and
-- the history of what happened includes the mistakes.
create or replace function refuse_ledger_rewrite() returns trigger
language plpgsql as $$
begin
  raise exception 'stock movements are append-only; record a correcting movement instead'
    using errcode = 'restrict_violation';
end;
$$;
--> statement-breakpoint
create trigger stock_movements_append_only
  before update or delete on stock_movements
  for each row execute function refuse_ledger_rewrite();
--> statement-breakpoint
-- On-hand, per product per branch. A view so the products list, the POS and
-- the check suite all read the SAME number rather than each summing it their
-- own way -- the same reason service_branch_pricing is a view.
create view stock_on_hand with (security_invoker = true) as
select p.id as product_id, t.id as team_id, p.organization_id,
       coalesce(sum(m.quantity), 0)::int as on_hand,
       p.reorder_level,
       (coalesce(sum(m.quantity), 0) <= p.reorder_level) as low
  from products p
  join teams t on t.organization_id = p.organization_id
  left join stock_movements m
    on m.product_id = p.id and m.team_id = t.id
 group by p.id, t.id, p.organization_id, p.reorder_level;
--> statement-breakpoint
alter table products enable row level security;
--> statement-breakpoint
alter table stock_movements enable row level security;
