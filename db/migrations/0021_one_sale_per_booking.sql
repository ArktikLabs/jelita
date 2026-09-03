-- One sale per booking, keyed on REVERSES_ID rather than status.
--
-- The original predicate excluded `status <> 'reversal'`, which was right
-- while a reversal was written straight to its final status. It stopped being
-- right when voiding started building the reversal as `open` first (so that
-- the line-immutability trigger would let it have its own lines): an open
-- reversal is not yet 'reversal', so it collided with the sale it was
-- reversing and voiding any booking-backed sale failed outright.
--
-- `reverses_id is not null` is true from the reversal's very first INSERT,
-- whatever its transient status -- so this cannot drift out of step with the
-- lifecycle again.
drop index if exists transactions_one_per_booking;
--> statement-breakpoint
create unique index transactions_one_per_booking
  on transactions (booking_id) where booking_id is not null and reverses_id is null;
