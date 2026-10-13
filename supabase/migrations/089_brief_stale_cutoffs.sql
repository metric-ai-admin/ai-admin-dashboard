-- 089 — where a record stops being work, on Kara's 6 AM brief.
--
-- NOT RUN YET. Arturo reviews this before it goes near Supabase (2026-10-13).
--
-- WHY. The first real brief put seven of eight properties in red, and most of
-- it was not work. Ascent had 40 "open make-readies", the oldest 490 days;
-- Highlander 196, iConic Downtown 213, Hyde Park 120. They are unit_turn_detail
-- rows nobody closed in AppFolio. Windy Hill had an application "pending" 89
-- days, which is not a decision being taken slowly.
--
-- A report that is all red is one nobody opens twice, so these two cutoffs
-- decide what counts: past them, a record goes to "Records to clean up in
-- AppFolio" and never into a red flag. They sit beside the other thresholds
-- for the same reason those do — the first month will show whether 90 and 60
-- are right, and that should not need a deploy.
--
-- THE REAL TEST IS NOT THE AGE, it is whether the unit is vacant today: a turn
-- on a unit somebody lives in finished, and only the paperwork is open. The
-- rent roll answers that and no column here can. These are the backstop for
-- the rows the rent roll cannot place.

alter table brief_thresholds
  add column if not exists make_ready_stale_days   integer,
  add column if not exists application_stale_days  integer;

comment on column brief_thresholds.make_ready_stale_days is
  'Past this many days an open unit turn is treated as a record to clean up '
  'rather than an active make-ready, whatever the rent roll says. Default 90.';

comment on column brief_thresholds.application_stale_days is
  'Past this many days a pending application is treated as a record to clean '
  'up rather than a decision outstanding. Default 60.';

-- Seed the default row only. A property-level override is something Kara asks
-- for, not something a migration decides.
update brief_thresholds
   set make_ready_stale_days = coalesce(make_ready_stale_days, 90),
       application_stale_days = coalesce(application_stale_days, 60),
       updated_by = 'migration 089',
       note = coalesce(note, '') || ' | stale cutoffs added 2026-10-13'
 where property = '*';

-- Verify:
--
--   select property, delinquency_over, make_ready_days, application_days,
--          make_ready_stale_days, application_stale_days
--     from brief_thresholds order by (property = '*') desc, property;
