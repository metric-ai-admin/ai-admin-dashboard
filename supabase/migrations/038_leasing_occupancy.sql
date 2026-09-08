-- 038_leasing_occupancy.sql
--
-- Current occupancy per property for the Leasing Goal Board, synced from
-- AppFolio's Reports API (occupancy report — slug verified via
-- GET /api/leasing/occupancy/raw). One row per property, upserted on
-- property_name.
--
-- Idempotent. Run in the Supabase SQL editor.

create table if not exists leasing_occupancy (
  id             uuid primary key default gen_random_uuid(),
  property_name  text unique,
  occupancy_pct  numeric,        -- 0–100
  occupied_units integer,
  total_units    integer,
  as_of          date,           -- report as-of date, when available
  synced_at      timestamptz default now()
);

create index if not exists leasing_occupancy_property_idx on leasing_occupancy (property_name);
