-- 086 — what day a weekly occupancy snapshot was actually made of.
--
-- NOT RUN YET. Arturo reviews this before it goes near Supabase (2026-10-12).
--
-- WHAT WENT WRONG. The Sunday 05:30 job copies leasing_occupancy into
-- leasing_occupancy_history and files it under the Saturday that just closed.
-- leasing_occupancy is overwritten by a sync that, until today, ran only when
-- somebody pressed a button — and nobody had pressed it since 2026-10-02. So
-- the row filed as "week ending 2026-10-10" holds 2026-10-02 figures, and the
-- row filed as "2026-10-03" holds the same ones. Both weeks are the same
-- numbers, which is exactly what a week-on-week comparison must never show,
-- and nothing in the table says so.
--
-- captureOccupancySnapshot already WORKS THIS OUT. It computes `stale` and
-- returns it — straight into a log line nobody reads a week later. The figure
-- existed and was thrown away at the last step. This stores it.
--
-- WHY A DATE AND NOT A BOOLEAN. "stale: true" cannot be acted on. The source
-- date can: a reader comparing two weeks can see that both rows were made of
-- 10/02 and that the comparison between them is empty, and a backfill can tell
-- which weeks are recoverable from which. A boolean would have to be
-- recomputed from information this table no longer holds.
--
-- NULL means a row written before this column existed — not "fresh". The two
-- rows that exist today are both stale, and scripts/mark-occupancy-history.js
-- fills them in from what we know; nothing infers freshness from a null.

alter table leasing_occupancy_history
  add column if not exists source_as_of date;

comment on column leasing_occupancy_history.source_as_of is
  'The as_of of the leasing_occupancy rows this snapshot was copied from. '
  'Equal to as_of when the sync ran that morning. Earlier than as_of means '
  'the week was captured from older figures and the row is only as good as '
  'that day. NULL means the row predates this column, not that it is fresh.';

-- Reading "which weeks are trustworthy" is the query this answers.
create index if not exists leasing_occupancy_history_source_idx
  on leasing_occupancy_history (as_of desc, source_as_of);

-- Verify (a healthy week has source_as_of = as_of on every property):
--
--   select as_of, source_as_of, count(*) properties,
--          sum(occupied_units) occupied, sum(total_units) units
--     from leasing_occupancy_history
--    group by as_of, source_as_of
--    order by as_of desc;
