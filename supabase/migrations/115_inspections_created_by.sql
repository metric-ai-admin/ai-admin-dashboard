-- Who created an inspection, and the end of keeping the resident's name on it.
--
-- Probe of 2026-10-26 (scripts/probe-inspection-columns.js): inspection_detail
-- returns `created_by` on 643 of 643 rows and the sync has never kept it. It is
-- the answer to the question a "Done under another name" row raises — the walk
-- is filed under somebody's name and nothing on the row says whose.
--
-- AND THE RESIDENT COMES OFF. maintenance_inspections.primary_resident is
-- filled on 78 of 642 rows and NOTHING READS IT: the only consumers of a
-- column by that name are on maintenance_work_orders (public/command-center.js),
-- a different table. We do not keep resident data in the tools (Arturo,
-- 2026-10-26), and a column nobody reads is the easiest kind to stop keeping.
--
-- NO NEW GRANTS. The 2026-10-30 rule covers tables created in `public` with no
-- explicit grant. A column added to an existing table inherits what the table
-- already has; maintenance_inspections was granted in 112.

-- ---------------------------------------------------------------------------
-- PART A — run this now.
-- ---------------------------------------------------------------------------

alter table maintenance_inspections add column if not exists created_by text;

comment on column maintenance_inspections.created_by is
  'Who created the inspection in AppFolio. Filled on 643/643 rows of inspection_detail. Shown on "Done under another name" rows, where the question is who actually walked the unit.';

-- The resident's name, cleared from the rows that have one.
--
-- THIS IS NOT PERMANENT ON ITS OWN. The maintenance support reports are
-- FULL-REPLACED each sync (server.js, MAINT_SUPPORT_REPORTS) — delete, then
-- insert what the report returned. So for as long as the sync still maps
-- primary_resident, the 06:05 run re-inserts the names this statement just
-- cleared, and the column is back to 78 filled rows by breakfast.
--
-- The deploy that drops the mapping is what makes it stick: once the map omits
-- the key, every re-inserted row carries NULL. This UPDATE only closes the gap
-- between now and that deploy. If the deploy slips past tomorrow's 06:05, run
-- it again — or run Part B, which cannot be undone by a sync.
update maintenance_inspections
   set primary_resident = null
 where primary_resident is not null;

-- ---------------------------------------------------------------------------
-- PART B — run this only AFTER the deploy that removes the mapping.
-- ---------------------------------------------------------------------------
--
-- Dropping the column is the guarantee; the UPDATE above is only a cleanup.
-- Held back to here because the order matters in one direction only: drop it
-- while the sync still maps primary_resident and the next insert fails on an
-- unknown column, which stops the inspections feed until the deploy lands.
--
-- Loud rather than silent, so not a disaster — but it would take the feed down
-- for a morning for no reason, and running it after the deploy costs nothing.
--
-- alter table maintenance_inspections drop column primary_resident;
