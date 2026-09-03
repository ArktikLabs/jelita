CREATE TABLE "payroll_deductions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"month" date NOT NULL,
	"amount" bigint NOT NULL,
	"note" text,
	"actor_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "staff_profiles" ADD COLUMN "base_salary" bigint;--> statement-breakpoint
ALTER TABLE "payroll_deductions" ADD CONSTRAINT "payroll_deductions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payroll_deductions_month_idx" ON "payroll_deductions" USING btree ("organization_id","month");--> statement-breakpoint
alter table staff_profiles add constraint staff_profiles_base_salary
  check (base_salary is null or base_salary >= 0);
--> statement-breakpoint
-- Positive only. The recap subtracts it, so a negative "deduction" would be a
-- bonus by the back door.
alter table payroll_deductions add constraint payroll_deductions_amount
  check (amount > 0);
--> statement-breakpoint
-- Pinned to the first of the month, so two rows for September cannot disagree
-- about which day September is.
alter table payroll_deductions add constraint payroll_deductions_month_start
  check (extract(day from month) = 1);
--> statement-breakpoint
alter table payroll_deductions
  add constraint payroll_deductions_person_fk foreign key (user_id, organization_id)
    references staff_profiles (user_id, organization_id) on delete cascade;
--> statement-breakpoint
alter table payroll_deductions enable row level security;
