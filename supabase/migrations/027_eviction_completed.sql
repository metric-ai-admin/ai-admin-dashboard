-- 027_eviction_completed.sql
--
-- Persistent "Mark Completed" state for the Eviction Tracker, independent of the
-- eviction_sessions snapshot. A Sync from AppFolio overwrites the session with
-- fresh delinquency data every day; without this table the completed marks saved
-- inside that snapshot would be lost on the next sync. Here the completed set is
-- keyed by the tracker's stable unit id (property||unit), so it survives syncs,
-- reloads, and new sessions — and only clears when a user clicks Undo.
--
-- Idempotent. Run in the Supabase SQL editor.

create table if not exists eviction_completed (
  id           text primary key,            -- property||unit key (the unit id in the tracker)
  property     text,
  unit         text,
  completed_at timestamptz default now(),
  completed_by text default 'Karla'
);
