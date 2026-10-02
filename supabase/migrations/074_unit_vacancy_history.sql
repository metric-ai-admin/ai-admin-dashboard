-- 074_unit_vacancy_history.sql
--
-- A WEEKLY HISTORY OF unit_vacancy, so a move-out is not lost when the unit
-- is re-rented.
--
-- WHY. unit_vacancy.last_move_out is the only source we have for weekly
-- move-outs: lease_history returns 23 rows with zero move_out values, and
-- box_score is not a valid report name in the API. Checked against Lyndsay's
-- workbook for 09/20-09/26, unit_vacancy matched her box score unit for unit,
-- all three of them.
--
-- The limit is what this table exists to fix. unit_vacancy lists only units
-- that are vacant or on notice AT THE MOMENT OF THE SYNC. A unit that moves
-- out and is re-occupied before the next sync drops off the report, and its
-- move-out with it — so the live report counts "move-outs still vacant", not
-- "move-outs". The two diverge exactly when leasing is going well, which is
-- the worst time for a number to quietly run low.
--
-- Snapshotting weekly means a unit that re-rents later is still recorded in
-- the week it actually emptied.
--
-- Same shape and same rules as 072 (leasing_occupancy_history): as_of is the
-- SATURDAY being described, never the day the writer ran.
create table if not exists unit_vacancy_history (
  id              bigserial primary key,

  as_of           date not null,
  property_name   text not null,
  property_id     text,
  unit            text not null,

  -- The three fields the KPI report needs from this feed. last_move_out is the
  -- reason the table exists; the other two say whether the unit was still
  -- empty when the snapshot was taken, which is what makes a later divergence
  -- explainable instead of mysterious.
  unit_status     text,
  last_move_out   date,
  last_move_in    date,

  days_vacant     integer,
  captured_at     timestamptz not null default now(),

  -- One row per unit per Saturday. A re-run corrects rather than duplicates,
  -- so a cron that fires twice cannot double a week's move-outs.
  constraint unit_vacancy_history_uniq unique (as_of, property_name, unit)
);

create index if not exists unit_vacancy_history_as_of_idx
  on unit_vacancy_history (as_of desc);

-- The query this table is for: move-outs in a given week, including units that
-- have since been re-rented and have therefore left the live report.
create index if not exists unit_vacancy_history_moveout_idx
  on unit_vacancy_history (last_move_out)
  where last_move_out is not null;

-- Verify:
--
--   select as_of, count(*) units,
--          count(*) filter (where last_move_out between as_of - 6 and as_of) move_outs_that_week
--     from unit_vacancy_history
--    group by as_of order by as_of desc limit 8;
--
-- For the week ending 2026-09-26 that move_outs_that_week column should read 3:
-- Ascent at Northgate 5-127, Hyde Park Square 107, iConic Round Rock 106.
