ALTER TABLE "salon_profiles" ADD COLUMN "auto_close_shift" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- An AUTOMATIC close has no closer.
--
-- The original check paired closed_at and closed_by both-or-neither, which was
-- right while every close was somebody pressing a button. Auto-close is not:
-- attributing it to whoever happened to ring up the first sale of the next day
-- would put a name on a decision they did not make.
--
-- The rule that survives is the one that actually matters: you cannot have a
-- closer without a close.
alter table shifts drop constraint shifts_closed_pair;
--> statement-breakpoint
alter table shifts add constraint shifts_closer_needs_close
  check (closed_by is null or closed_at is not null);
