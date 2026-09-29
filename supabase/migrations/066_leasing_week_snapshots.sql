-- 066_leasing_week_snapshots.sql
--
-- A daily record of WHICH leads were in each week, not just how many.
--
-- WHY. On 2026-09-29 the week ending 09/26 went from 68 leads to 67 overnight.
-- Three checks proved the missing row had not changed week and had not changed
-- date, and there is no DELETE against leasing_leads anywhere in the codebase —
-- but the row could not be NAMED, because yesterday's count had been verified
-- and then thrown away. A number tells you something changed; only the ids tell
-- you what.
--
-- It took a screenshot of the dashboard to narrow it to Hyde Park Square. That
-- is not a method.
--
-- SIZE. One row per week per day, holding the ids as an array: roughly 68 ids
-- of 36 characters, about 2.5 KB per week. The writer keeps the last 8 weeks
-- only, so a day costs ~20 KB and a year around 7 MB. Old snapshots can be
-- deleted at any time without losing anything else.
--
-- Run in the Supabase SQL editor BEFORE deploying the code that writes it.
-- Idempotent and safe to re-run.

create table if not exists leasing_week_snapshots (
  -- The business day the snapshot was taken (America/Chicago), not an instant:
  -- one snapshot per day per week, and re-running the sync the same day should
  -- replace it rather than pile up.
  snapshot_date date not null,
  week_ending   date not null,
  lead_count    integer not null,
  -- The ids themselves. This is the column the whole table exists for — the
  -- count can be derived, the membership cannot.
  appfolio_ids  text[] not null default '{}',
  captured_at   timestamptz not null default now(),
  primary key (snapshot_date, week_ending)
);

-- "What did this week look like over the past fortnight?" — the read that
-- answers a number moving.
create index if not exists leasing_week_snapshots_week_idx
  on leasing_week_snapshots (week_ending, snapshot_date desc);

-- Verify, after the next 05:30 run:
--
--   select snapshot_date, week_ending, lead_count
--     from leasing_week_snapshots
--    order by snapshot_date desc, week_ending desc limit 16;
--
-- And the question that cost a day — which ids left a week between two days:
--
--   select a.week_ending,
--          array(select unnest(a.appfolio_ids) except select unnest(b.appfolio_ids)) as gone,
--          array(select unnest(b.appfolio_ids) except select unnest(a.appfolio_ids)) as added
--     from leasing_week_snapshots a
--     join leasing_week_snapshots b
--       on b.week_ending = a.week_ending and b.snapshot_date = a.snapshot_date + 1
--    where a.snapshot_date = current_date - 1;
