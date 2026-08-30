CREATE TABLE "features" (
	"key" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_features" (
	"plan_id" bigint NOT NULL,
	"feature_key" text NOT NULL,
	CONSTRAINT "plan_features_plan_id_feature_key_pk" PRIMARY KEY("plan_id","feature_key")
);
--> statement-breakpoint
CREATE TABLE "plan_limits" (
	"plan_id" bigint NOT NULL,
	"resource" text NOT NULL,
	"cap" integer NOT NULL,
	CONSTRAINT "plan_limits_plan_id_resource_pk" PRIMARY KEY("plan_id","resource")
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "plans_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"key" text NOT NULL,
	"name" text NOT NULL,
	"price_idr" bigint DEFAULT 0 NOT NULL,
	"billing_interval" text DEFAULT 'month' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "plans_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "subscriptions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" text NOT NULL,
	"plan_id" bigint NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"current_period_start" timestamp with time zone DEFAULT now() NOT NULL,
	"current_period_end" timestamp with time zone,
	"provider" text DEFAULT 'manual' NOT NULL,
	"provider_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_organization_id_unique" UNIQUE("organization_id")
);
--> statement-breakpoint
ALTER TABLE "plan_features" ADD CONSTRAINT "plan_features_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_features" ADD CONSTRAINT "plan_features_feature_key_features_key_fk" FOREIGN KEY ("feature_key") REFERENCES "public"."features"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_limits" ADD CONSTRAINT "plan_limits_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_features_feature_idx" ON "plan_features" USING btree ("feature_key");--> statement-breakpoint
CREATE INDEX "subscriptions_plan_idx" ON "subscriptions" USING btree ("plan_id");