-- 087 — the lease start date on a rental application.
--
-- NOT RUN YET. Arturo reviews this before it goes near Supabase (2026-10-12).
--
-- WHY. Katie's "New Applications" counts everything still standing, and her
-- rule excludes anything Approved WITH A LEASE START DATE — approved and
-- already carried through to a signed lease. leasing_applications has no such
-- column, so the report approximates that condition with detailed_status
-- (Converted or Converting). The approximation is defensible and it is not
-- her rule, and the two part company on exactly the applications that are
-- approved but not yet marked Converting.
--
-- The column is nullable and nothing is backfilled: rows already in the table
-- were synced without it and a null here means "we did not ask for this when
-- this row was written", which is true. The next full sync fills them in.
--
-- NULL IS NOT "NO LEASE". A reader — and the report — must treat a null as
-- unknown, not as evidence that the application has no lease start, or every
-- row synced before today would silently count as still pending.

alter table leasing_applications
  add column if not exists lease_start_date date;

comment on column leasing_applications.lease_start_date is
  'Lease start on the rental application, from the Rental Applications '
  'report. Katie''s pending count excludes applications that are Approved '
  'AND carry one. NULL means the row was synced before this column existed, '
  'not that the application has no lease start.';

-- Reading "which applications are still standing" is the query the report
-- makes, and it reads this column beside the two statuses.
create index if not exists leasing_applications_standing_idx
  on leasing_applications (property_name, status, lease_start_date);

-- Verify (after the next full sync — expect far more than the 70 rows the
-- table held on 2026-10-12, and most Approved rows to carry a date):
--
--   select count(*) total,
--          count(*) filter (where lease_start_date is not null) with_lease,
--          count(*) filter (where status = 'Approved') approved
--     from leasing_applications;
