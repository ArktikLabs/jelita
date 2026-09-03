CREATE TABLE "shifts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"team_id" text NOT NULL,
	"opened_by" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	CONSTRAINT "shifts_org_id" UNIQUE("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "salon_profiles" ADD COLUMN "next_invoice_no" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "shift_id" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "invoice_no" integer;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shifts_open_idx" ON "shifts" USING btree ("organization_id","team_id","closed_at");--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_invoice_no" UNIQUE("organization_id","invoice_no");--> statement-breakpoint
alter table shifts
  add constraint shifts_team_fk foreign key (team_id, organization_id)
    references teams (id, organization_id) on delete cascade;
--> statement-breakpoint
-- A shift closes once. Reopening one would put settled takings back inside a
-- window that is supposed to have shut.
alter table shifts add constraint shifts_closed_pair
  check ((closed_at is null) = (closed_by is null));
--> statement-breakpoint
-- ONE open shift per branch. Without this, a second auto-open races the first
-- and the day's sales split across two windows that both look current.
create unique index shifts_one_open_per_branch
  on shifts (team_id) where closed_at is null;
--> statement-breakpoint
alter table transactions
  add constraint transactions_shift_fk foreign key (organization_id, shift_id)
    references shifts (organization_id, id);
--> statement-breakpoint
-- Voiding is refused once the shift has closed (spec 2.7).
--
-- A trigger and not application code, for the reason every other guarantee
-- here is: a void is an INSERT of a reversal, so the immutability trigger on
-- updates does not cover it, and "the window has shut" is exactly the rule a
-- report or a fix-it script would not think to check.
create or replace function refuse_void_after_shift() returns trigger
language plpgsql as $$
declare
  shut timestamptz;
begin
  if new.reverses_id is null then return new; end if;
  select s.closed_at into shut
    from transactions t
    left join shifts s on s.id = t.shift_id
   where t.id = new.reverses_id;
  if shut is not null then
    raise exception 'transaction % belongs to a shift that closed at %',
      new.reverses_id, shut
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger transactions_void_within_shift
  before insert on transactions
  for each row execute function refuse_void_after_shift();
--> statement-breakpoint
alter table shifts enable row level security;
