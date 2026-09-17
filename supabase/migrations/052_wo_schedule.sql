-- 052_wo_schedule.sql
--
-- WO Scheduling Tool (iConic pilot) — the scheduling layer.
--
-- AppFolio's Reports API v2 is READ-ONLY: there is no write-back for work order
-- assignment or scheduling (confirmed 2026-09-17; the Stack API has a Work Orders
-- resource but we have no credentials for it). So a scheduled date and tech live
-- here, and AppFolio stays the source of truth for the work order itself.
--
-- That means this table is a SIDE-CAR, not a mirror. It deliberately stores only
-- what AppFolio cannot hold for us:
--
--   work_order_number  AppFolio's WO id ("21836-1") — the join key back to the
--                      wo_all report. Not a real FK: work orders live in
--                      AppFolio, not in this database, so nothing here can
--                      enforce referential integrity. A row whose WO has since
--                      closed simply stops matching and is ignored by the UI.
--   scheduled_date     the day the work is planned for (date, not timestamp —
--                      the pilot schedules by day, not by time slot)
--   scheduled_tech     free text, matching the AppFolio assigned_user spelling
--                      ("Carlos Portilla"). Not an FK to technicians: that table
--                      is keyed on its own ids and does not cover vendors.
--   estimated_hours    defaults to 2.0, overridable per WO
--   notes              scheduler's note, e.g. "resident only home after 4"
--
-- One schedule row per work order — rescheduling updates in place rather than
-- appending, so the unique index below is what makes the upsert safe.
--
-- Idempotent; the Supabase SQL editor ignores BEGIN/COMMIT, so each statement
-- guards itself. Run in the Supabase SQL editor.

create table if not exists wo_schedule (
  id                 uuid primary key default gen_random_uuid(),
  work_order_number  text not null,
  property_name      text,
  unit_name          text,
  scheduled_date     date,
  scheduled_tech     text,
  estimated_hours    numeric(5,2) default 2.0,
  notes              text,
  created_by         text,
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);

-- Makes the upsert in /api/appfolio/schedule safe: dragging the same WO to a new
-- day updates its row instead of leaving two conflicting schedules behind.
create unique index if not exists wo_schedule_wo_key
  on wo_schedule (work_order_number);

-- The calendar reads one week at a time.
create index if not exists wo_schedule_date_idx
  on wo_schedule (scheduled_date);

-- Per-tech day load, for the capacity readout.
create index if not exists wo_schedule_tech_date_idx
  on wo_schedule (scheduled_tech, scheduled_date);

-- Check:
--   select scheduled_date, scheduled_tech, count(*), sum(estimated_hours)
--   from wo_schedule group by 1, 2 order by 1 desc, 2;
