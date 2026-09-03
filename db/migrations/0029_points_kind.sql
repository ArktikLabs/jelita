-- Points can be earned per SPEND or per VISIT.
--
-- 0028 only had "Rp X spent = 1 point", which is what PRD §5.7 words. A flat
-- award per transaction is the other common scheme, and a salon wants to pick.
--
-- Same shape as the commission rule (0020): a `kind` and a `value`, both-or-
-- neither. Not two separate nullable columns per scheme -- that admits
-- "spend rate set, visit rate set" and every reader would have to decide a
-- precedence, which is how two readers pick differently.
alter table salon_profiles rename column points_per_unit to points_value;
--> statement-breakpoint
alter table salon_profiles add column points_kind text;
--> statement-breakpoint
-- Everything configured before this migration was a spend rate.
update salon_profiles set points_kind = 'spend' where points_value is not null;
--> statement-breakpoint
alter table salon_profiles drop constraint salon_profiles_points_per_unit;
--> statement-breakpoint
-- `spend` = this many rupiah earns one point. `visit` = this many points per
-- transaction, whatever it cost.
alter table salon_profiles add constraint salon_profiles_points
  check ((points_kind is null) = (points_value is null)
         and (points_kind is null or points_kind in ('spend', 'visit'))
         and (points_value is null or points_value > 0));
