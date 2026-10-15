-- 100 — mark lease rows the report has stopped returning, instead of letting
-- them pass for current.
--
-- Arturo, 2026-10-15. The sync UPSERTS what the report returns and never
-- revisits what it does not, so a lease that leaves the report keeps its last
-- known values for ever — and a stale row reads exactly like a current one.
--
-- The Chateau: a "future move-in" dated 2026-11-10 on a row last touched
-- 2026-10-02, while 31 others were refreshed that morning. Leasing says the
-- real date is 10/11, in the past, which is why the lease had left the report
-- at all. Kara's brief counted a phantom arrival and raised a data conflict
-- over it. 51 of 82 rows were in that state.
--
-- THIS IS THE WORK-ORDER FIX, APPLIED AGAIN. lib/work-order-status.js already
-- solved the same problem for maintenance_work_orders in 2026-10: a sync that
-- only asks for open work orders leaves closed ones frozen as open for ever,
-- and the answer there was a third state — "Unknown — not in feed" — rather
-- than a guess in either direction. 31 work orders carry it today.
--
-- NOTHING IS DELETED. A lease that left the report is still the best record we
-- have of what that lease was; it just cannot be read as what is true now.
-- `last_seen_at` says when the report last mentioned it, and `in_feed` is the
-- flag readers filter on.

alter table leasing_lease_history
  add column if not exists last_seen_at timestamptz;

alter table leasing_lease_history
  add column if not exists in_feed boolean;

-- EXISTING ROWS ARE SEEDED FROM synced_at, which until now was only ever
-- written when the row was seen. That makes the backfill exact rather than a
-- guess: every row's last_seen_at IS its synced_at.
update leasing_lease_history
   set last_seen_at = synced_at
 where last_seen_at is null;

-- And the ones already stale are marked as such, using the newest synced_at in
-- the table as "the latest run". Rows from the latest run stay in the feed.
update leasing_lease_history
   set in_feed = (synced_at::date = (select max(synced_at)::date from leasing_lease_history))
 where in_feed is null;

create index if not exists leasing_lease_history_in_feed_idx
  on leasing_lease_history (in_feed, move_in_date);

comment on column leasing_lease_history.last_seen_at is
  'When the AppFolio report last returned this lease. NOT when the row was written.';
comment on column leasing_lease_history.in_feed is
  'FALSE once the report stops returning the lease. Readers that describe the present must filter on in_feed; a stale row reads exactly like a current one.';

-- Verify:
--   select in_feed, count(*), min(last_seen_at)::date, max(last_seen_at)::date
--     from leasing_lease_history group by 1;
--   select count(*) from leasing_lease_history
--     where in_feed is false and move_in_date >= current_date;
