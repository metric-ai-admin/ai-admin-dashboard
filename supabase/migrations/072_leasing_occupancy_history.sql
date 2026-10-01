-- 072_leasing_occupancy_history.sql
--
-- A WEEKLY HISTORY OF OCCUPANCY, so "as of Saturday" can be answered later.
--
-- WHY. leasing_occupancy is a snapshot keyed on property_name: the sync
-- overwrites it, so it only ever holds the day it last ran. On 2026-10-01 it
-- held 09/16 and 09/28, and Lyndsay's KPI report wants 09/26. Comparing our
-- numbers to hers put four properties' occupied counts off by one for that
-- reason alone — the arithmetic was right and the day was wrong.
--
-- This table is append-only history. leasing_occupancy keeps doing exactly
-- what it does now; nothing reads differently until something is written to
-- read from it.
--
-- Run this BEFORE the cron change that writes to it. The writer is a no-op
-- while the table does not exist, but there is no reason to run them apart.
create table if not exists leasing_occupancy_history (
  id              bigserial primary key,

  -- The Saturday this row describes. Not the day the row was written: a
  -- Saturday capture that runs at 5:30 AM Sunday still describes Saturday,
  -- and keying on the write date would file it under the wrong week.
  as_of           date not null,
  property_name   text not null,
  property_id     text,

  -- The five numbers Lyndsay's occupancy section is built from. Named as her
  -- report names them so the mapping needs no translation table:
  --   Occupancy % = occupied_units / total_units  (summed, never averaged)
  --   Preleased   = occupied_units + vacant_rented
  total_units     integer,
  occupied_units  integer,
  vacant_rented   integer,
  notice_units    integer,
  occupancy_pct   numeric(6,4),

  captured_at     timestamptz not null default now(),

  -- One row per property per Saturday. A re-run corrects the row rather than
  -- adding a second, so a cron that fires twice cannot double the portfolio.
  constraint leasing_occupancy_history_uniq unique (as_of, property_name)
);

create index if not exists leasing_occupancy_history_as_of_idx
  on leasing_occupancy_history (as_of desc);

-- Verify:
--
--   select as_of, count(*) properties, sum(total_units) units,
--          sum(occupied_units) occupied,
--          round(sum(occupied_units)::numeric / nullif(sum(total_units),0), 4) pct
--     from leasing_occupancy_history
--    group by as_of order by as_of desc limit 8;
--
-- The pct column there is the portfolio number the way the report computes it:
-- summed first, divided once. Averaging the per-property percentages gives a
-- different answer and is the mistake this schema is shaped to discourage.
