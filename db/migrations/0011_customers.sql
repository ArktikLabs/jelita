CREATE TABLE "customers" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"phone_key" text,
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_org_id" UNIQUE("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customers_org_name_idx" ON "customers" USING btree ("organization_id","name");--> statement-breakpoint
-- One customer per number per salon.
--
-- PARTIAL only to keep the phone-less rows out of the index. Postgres treats
-- NULLs as DISTINCT in a unique index by default, so a plain unique index
-- would already accept any number of customers with no phone -- verified, not
-- assumed. The `where` clause is a size optimisation and a statement of
-- intent, NOT what makes the walk-in case work.
create unique index customers_org_phone_key
  on customers (organization_id, phone_key)
  where phone_key is not null;
--> statement-breakpoint
alter table customers enable row level security;
