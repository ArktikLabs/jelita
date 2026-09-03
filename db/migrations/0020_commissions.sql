CREATE TABLE "commissions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"transaction_id" text NOT NULL,
	"transaction_line_id" text NOT NULL,
	"staff_user_id" text NOT NULL,
	"kind" text NOT NULL,
	"value" integer NOT NULL,
	"amount" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commissions_one_per_line" UNIQUE("transaction_line_id")
);
--> statement-breakpoint
ALTER TABLE "salon_profiles" ADD COLUMN "commission_kind" text;--> statement-breakpoint
ALTER TABLE "salon_profiles" ADD COLUMN "commission_value" integer;--> statement-breakpoint
ALTER TABLE "service_staff" ADD COLUMN "commission_kind" text;--> statement-breakpoint
ALTER TABLE "service_staff" ADD COLUMN "commission_value" integer;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "commission_kind" text;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "commission_value" integer;--> statement-breakpoint
CREATE INDEX "commissions_recap_idx" ON "commissions" USING btree ("organization_id","staff_user_id");--> statement-breakpoint
-- The pair is both-null or both-set at every level: a kind with no value is a
-- half-configured rule that would silently earn nothing.
alter table salon_profiles add constraint salon_profiles_commission
  check ((commission_kind is null) = (commission_value is null)
         and (commission_kind is null or commission_kind in ('percent', 'flat'))
         and (commission_value is null or commission_value >= 0)
         and (commission_kind <> 'percent' or commission_value <= 10000));
--> statement-breakpoint
alter table services add constraint services_commission
  check ((commission_kind is null) = (commission_value is null)
         and (commission_kind is null or commission_kind in ('percent', 'flat'))
         and (commission_value is null or commission_value >= 0)
         and (commission_kind <> 'percent' or commission_value <= 10000));
--> statement-breakpoint
-- 10000 basis points is 100%. A rate above the sale price is a typo, not a
-- business model, and one that reached payroll would be found by the person
-- who got paid.
alter table service_staff add constraint service_staff_commission
  check ((commission_kind is null) = (commission_value is null)
         and (commission_kind is null or commission_kind in ('percent', 'flat'))
         and (commission_value is null or commission_value >= 0)
         and (commission_kind <> 'percent' or commission_value <= 10000));
--> statement-breakpoint
alter table commissions add constraint commissions_kind
  check (kind in ('percent', 'flat'));
--> statement-breakpoint
alter table commissions
  add constraint commissions_txn_fk foreign key (organization_id, transaction_id)
    references transactions (organization_id, id) on delete cascade;
--> statement-breakpoint
alter table commissions
  add constraint commissions_line_fk foreign key (transaction_line_id)
    references transaction_lines (id) on delete cascade;
--> statement-breakpoint
alter table commissions
  add constraint commissions_staff_fk foreign key (staff_user_id, organization_id)
    references staff_profiles (user_id, organization_id);
--> statement-breakpoint
-- Commission rows hang off a settled transaction, so they follow the same rule
-- its lines do: writable while the parent is open, refused after. The function
-- already exists (0018) -- this attaches it to one more table rather than
-- restating the rule.
create trigger commissions_settled_immutable
  before insert or update or delete on commissions
  for each row execute function refuse_settled_line_write();
--> statement-breakpoint
-- Which rule applies to (service, staff)?
--
-- salon default -> service override -> service+staff override, the same
-- coalesce shape service_branch_pricing uses for price. In SQL so checkout and
-- the check suite resolve it identically rather than the tests re-implementing
-- the precedence and proving only that the copy works.
-- kind and value are coalesced INDEPENDENTLY, which is only safe because the
-- checks above force each level to set both or neither. Without them a level
-- could contribute its kind while a different level contributed the value --
-- 'flat' with a basis-point number, silently. The constraint is what makes
-- this shape correct, and it is asserted directly.
create view commission_rule with (security_invoker = true) as
select ss.service_id, ss.user_id, ss.organization_id,
       coalesce(ss.commission_kind, s.commission_kind, p.commission_kind) as kind,
       coalesce(ss.commission_value, s.commission_value, p.commission_value) as value
  from service_staff ss
  join services s on s.id = ss.service_id and s.organization_id = ss.organization_id
  join salon_profiles p on p.organization_id = ss.organization_id;
--> statement-breakpoint
alter table commissions enable row level security;
