-- 101 — the same feed marking on applications, before it costs anything.
--
-- Arturo, 2026-10-15: apply it now even though it is benign today, so the
-- Chateau does not happen again with an application.
--
-- It IS benign today, and the check is worth writing down: of the 10
-- applications the latest sync did not return, 5 are Approved, 4 Canceled and
-- 1 Denied. Not one is pending, so nothing stale is currently being shown as
-- awaiting a decision. Nothing enforces that — the next one could be a
-- Decision Pending row frozen for ever, which is exactly how a lease dated
-- 2026-11-10 reached Kara's brief from a row last seen on 2026-10-02.
--
-- THE WINDOW IS WHY THE BACKFILL IS DIFFERENT FROM 100. The applications
-- report is fetched with received_on_from = today - 90 days, so an
-- application older than that is absent because nobody asked about it. Rows
-- outside the window are left NULL rather than marked either way: in_feed
-- false would say "the report dropped it", and true would say "the report
-- still has it", and neither is something we know.
--
-- NULL therefore means "never assessed" here, and readers must treat it the
-- way the brief does: only an explicit false is stale.

alter table leasing_applications
  add column if not exists last_seen_at timestamptz;

alter table leasing_applications
  add column if not exists in_feed boolean;

-- last_seen_at is exact: synced_at was only ever written when the row was
-- seen, so it IS the date the report last returned it.
update leasing_applications
   set last_seen_at = synced_at
 where last_seen_at is null;

-- Only rows inside the window the sync actually asks about. The 90 days is
-- the sync's own default; a row older than that has never been assessed and
-- stays NULL.
update leasing_applications
   set in_feed = (synced_at::date = (select max(synced_at)::date from leasing_applications))
 where in_feed is null
   and application_date >= (current_date - interval '90 days');

create index if not exists leasing_applications_in_feed_idx
  on leasing_applications (in_feed, application_date);

comment on column leasing_applications.last_seen_at is
  'When the AppFolio report last returned this application. NOT when the row was written.';
comment on column leasing_applications.in_feed is
  'FALSE once the report stops returning it WITHIN the 90-day window the sync asks about. NULL = outside that window, never assessed — not the same as false.';

-- Verify:
--   select in_feed, count(*) from leasing_applications group by 1;
--   select status, count(*) from leasing_applications
--    where in_feed is false group by 1 order by 2 desc;
