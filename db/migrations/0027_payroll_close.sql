CREATE TABLE "payroll_run_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"base_salary" bigint,
	"commission" bigint NOT NULL,
	"deductions" bigint NOT NULL,
	"net" bigint NOT NULL,
	CONSTRAINT "payroll_run_lines_one_per_staff" UNIQUE("run_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "payroll_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"month" date NOT NULL,
	"closed_by" text,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_runs_org_month" UNIQUE("organization_id","month")
);
--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
alter table payroll_runs add constraint payroll_runs_month_start
  check (extract(day from month) = 1);
--> statement-breakpoint
alter table payroll_run_lines
  add constraint payroll_run_lines_run_fk foreign key (run_id)
    references payroll_runs (id) on delete cascade;
--> statement-breakpoint
alter table payroll_run_lines
  add constraint payroll_run_lines_person_fk foreign key (user_id, organization_id)
    references staff_profiles (user_id, organization_id) on delete cascade;
--> statement-breakpoint
-- A closed month is closed.
--
-- The recap reads the snapshot once a month is closed, so an edited deduction
-- would no longer change the NUMBER -- but it would still change what the
-- deductions list shows beside it, and a stylist holding a payslip would find
-- the screen disagreeing with the paper.
--
-- Not deferred, unlike the ownerless guard: nothing legitimate passes through
-- a moment where a closed month is being edited, and failing at the statement
-- names the write that caused it.
create or replace function refuse_closed_month_write() returns trigger
language plpgsql as $$
declare
  target date;
  org text;
begin
  target := coalesce(new.month, old.month);
  org := coalesce(new.organization_id, old.organization_id);
  if exists (select 1 from payroll_runs r
              where r.organization_id = org and r.month = target) then
    raise exception 'payroll for % is closed; record the correction in the next month',
      to_char(target, 'YYYY-MM')
      using errcode = 'restrict_violation';
  end if;
  return coalesce(new, old);
end;
$$;
--> statement-breakpoint
create trigger payroll_deductions_month_closed
  before insert or update or delete on payroll_deductions
  for each row execute function refuse_closed_month_write();
--> statement-breakpoint
-- And a closed month does not reopen: a correction belongs in the next month,
-- where it is visible as a correction rather than silently altering a period
-- that has been paid and reported.
create or replace function refuse_payroll_reopen() returns trigger
language plpgsql as $$
begin
  -- Deleting the salon cascades into its runs, and a salon that no longer
  -- exists has no payroll to reopen. Same carve-out the ownerless guard needs
  -- (0025), and for the same reason: a cascade must not be refused by a rule
  -- about the rows it is cascading into.
  if not exists (select 1 from organizations where id = old.organization_id) then
    return old;
  end if;

  raise exception 'payroll for % is closed and cannot be reopened',
    to_char(old.month, 'YYYY-MM')
    using errcode = 'restrict_violation';
end;
$$;
--> statement-breakpoint
create trigger payroll_runs_no_reopen
  before update or delete on payroll_runs
  for each row execute function refuse_payroll_reopen();
--> statement-breakpoint
alter table payroll_runs enable row level security;
--> statement-breakpoint
alter table payroll_run_lines enable row level security;
