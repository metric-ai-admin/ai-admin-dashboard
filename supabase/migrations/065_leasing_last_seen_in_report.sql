-- 065_leasing_last_seen_in_report.sql
--
-- Record WHEN a lead was last returned by the AppFolio report.
--
-- WHY. guest_card_inquiries returns ACTIVE cards only — established 2026-09-28
-- from the AppFolio UI, after two rounds of investigation that assumed a merge
-- or a deletion. A card that goes inactive simply stops appearing, and until
-- now nothing recorded that. Answering "which of our leads has AppFolio stopped
-- returning?" meant comparing synced_at against a full pull by hand, which is
-- exactly the archaeology this column removes.
--
-- WHAT IT IS AND IS NOT. It records an OBSERVATION — "this row came back in the
-- pull at this time" — and nothing else. It deliberately does not become a
-- status column: we never saw AppFolio's own status for these rows, and
-- inventing one ("Inactive", "Gone") would be a guess stored as a fact, which
-- is the mistake this whole thread has been about. A row that stops being seen
-- may be inactive, or renamed, or the report may have changed again.
--
-- NULL means "not seen since this column existed", not "missing". Every row is
-- null until the next sync, and backfilling from synced_at would be a lie:
-- synced_at says when we WROTE the row, and with the range filter in place a
-- row can be written without having been in that day's report at all.
--
-- Run in the Supabase SQL editor BEFORE deploying the code that writes it.
-- Idempotent and safe to re-run.

alter table leasing_leads add column if not exists last_seen_in_report timestamptz;

-- "What has AppFolio stopped returning?" is the read this exists for.
create index if not exists leasing_leads_last_seen_idx
  on leasing_leads (last_seen_in_report);

-- Verify, after the next sync has run:
--
--   select count(*) filter (where last_seen_in_report is null)            as never_seen,
--          count(*) filter (where last_seen_in_report > now() - interval '2 days') as seen_recently,
--          count(*)                                                        as total
--     from leasing_leads;
--
-- Leads AppFolio has stopped returning, by week — the query that took three
-- rounds of manual work on 2026-09-28:
--
--   select week_ending, count(*)
--     from leasing_leads
--    where last_seen_in_report is not null
--      and last_seen_in_report < now() - interval '2 days'
--    group by 1 order by 1 desc;
