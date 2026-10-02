-- 076_work_orders_completed_on.sql
--
-- When a work order was completed, and when we last saw it in the feed.
--
-- WHY completed_on. "Work Orders Closed This Week" needs a completion date and
-- we have none: the comparison reads 0 everywhere because workOrdersFrom falls
-- back to updated_at, which is when WE touched the row, not when the work was
-- done. AppFolio's work_order report returns completed_on; we have simply never
-- stored it.
--
-- WHY last_seen_in_feed, which is the bigger of the two.
--
-- The sync asks for open statuses only (work_order_statuses 0,1,2,9,11,3) and
-- UPSERTS. A work order that gets completed stops coming back in the feed, so
-- its row is never updated again and keeps whatever open status it had — for
-- ever. Measured on 2026-10-02 for Ascent at Northgate alone: we hold 88 open
-- work orders, of which 38 are not in Lyndsay's open report at all. Six of
-- those she has as COMPLETED that same week. They are not disagreements, they
-- are rows nobody ever closed.
--
-- This does not fix it by itself — the sync has to stamp last_seen_in_feed on
-- every row it writes, and something has to decide what a row that stopped
-- appearing means. But the column has to exist before that can be written, and
-- it makes the problem measurable today:
--
--   select count(*) from maintenance_work_orders
--    where last_seen_in_feed < now() - interval '2 days'
--      and status not in ('Completed', 'Canceled');
--
-- Both nullable, no backfill. A row from before this exists has no honest
-- value for either, and inventing one would hide exactly the staleness this is
-- meant to expose.
alter table maintenance_work_orders
  add column if not exists completed_on date;

alter table maintenance_work_orders
  add column if not exists last_seen_in_feed timestamptz;

create index if not exists maintenance_work_orders_completed_on_idx
  on maintenance_work_orders (completed_on)
  where completed_on is not null;

create index if not exists maintenance_work_orders_last_seen_idx
  on maintenance_work_orders (last_seen_in_feed);

-- Verify, after the sync has run once:
--
--   select count(*) filter (where last_seen_in_feed is null)      never_seen_again,
--          count(*) filter (where last_seen_in_feed is not null)  still_in_feed
--     from maintenance_work_orders;
--
-- The first number is the backlog of rows the feed has stopped returning. It
-- should be large on the first run and stop growing after that.
