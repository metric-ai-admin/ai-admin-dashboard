-- Eviction Tracker — persisted upload sessions
--
-- The eviction tool was a standalone React HTML that lost its data on refresh.
-- Migrated into the dashboard: each AppFolio upload (Delinquency + Activities +
-- Calls + Directory, parsed client-side) is saved here as one row, and opening
-- the tab loads the most recent one.
--
-- data holds the app's own hydration shape — { units, activities, reportDate,
-- reportDay } — exactly what its #preload-data path revives, so a saved session
-- reloads identically to a fresh upload. Stored as JSONB, parsing untouched.
--
-- Run in the Supabase SQL editor. Every statement is IF NOT EXISTS and safe to
-- re-run; the editor does not honour BEGIN/COMMIT.

create table if not exists eviction_sessions (
  id           uuid primary key default gen_random_uuid(),
  uploaded_at  timestamptz not null default now(),
  uploaded_by  text,
  data         jsonb not null,
  -- The report's own "as of" date, extracted from the Delinquency sheet — not
  -- the upload time. Lets a session be identified by the day it represents.
  report_date  date
);

-- The only read is "the latest session", so index the sort key.
create index if not exists eviction_sessions_uploaded_at_idx
  on eviction_sessions (uploaded_at desc);

-- Check — most recent session:
-- select id, uploaded_at, uploaded_by, report_date,
--        jsonb_array_length(coalesce(data->'units','[]'::jsonb)) as units
-- from eviction_sessions order by uploaded_at desc limit 5;
