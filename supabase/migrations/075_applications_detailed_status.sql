-- 075_applications_detailed_status.sql
--
-- The application status column we have been throwing away.
--
-- rental_applications returns TWO status fields. Lyndsay's workbook shows them
-- side by side:
--
--   "Status"              Converted 96 · Converting 8 · Canceled 12 ·
--                         Decision Pending 9 · Approved 5 · Denied 5 ·
--                         In Screening 1
--   "Application Status"  Approved 108 · Canceled 12 · Decision Pending 10 ·
--                         Denied 5 · In Screening 1
--
-- Our sync maps the SECOND one into leasing_applications.status. Her report's
-- Vacant Rented counts applications whose status is "Converting" — approved and
-- moving toward a move-in that has not happened yet, as distinct from
-- "Converted", where the move-in already did. That value exists only in the
-- first column, so it has never reached us and Vacant Rented could not be
-- computed at all.
--
-- A NEW COLUMN, NOT A CHANGED ONE. application_status stays exactly as it is:
-- Katie's Goal Board counts Approved off it, and repointing it at a field where
-- 96 of 136 rows read "Converted" would change her numbers silently, in a
-- surface nobody is looking at this week.
--
-- Nullable with no default and no backfill. Rows synced before this exists keep
-- NULL, which reads as "we did not capture it" rather than as a status — and
-- the Vacant Rented count should say it is incomplete rather than quietly
-- undercount until the next sync fills them in.
alter table leasing_applications
  add column if not exists detailed_status text;

create index if not exists leasing_applications_detailed_status_idx
  on leasing_applications (detailed_status)
  where detailed_status is not null;

-- Verify, after the sync has run once:
--
--   select detailed_status, status, count(*)
--     from leasing_applications
--    group by detailed_status, status
--    order by count(*) desc;
--
-- Expect "Converting" and "Converted" to appear only in detailed_status, and
-- status to keep the values the Goal Board already reads.
