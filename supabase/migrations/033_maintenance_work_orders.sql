-- 033_maintenance_work_orders.sql
--
-- Active work orders synced from AppFolio's Reports API (work_order.json), for
-- Erick's Maintenance Command Center. Replaces the manual daily Excel upload
-- (Claude_Maintenance_Coordinator_Daily_Task_Data_Source.xlsx). One row per work
-- order, de-duplicated by work_order_number.
--
-- Idempotent. Run in the Supabase SQL editor.

create table if not exists maintenance_work_orders (
  id                     uuid primary key default gen_random_uuid(),
  work_order_number      text unique,           -- e.g. "14196-1" (upsert key)
  property               text,
  property_name          text,
  property_id            text,
  unit                   text,
  issue                  text,                  -- Work Order Issue (title)
  description            text,                  -- Job Description
  status                 text,
  priority               text,                  -- Normal, High, Critical
  work_order_type        text,                  -- Internal, Resident, Unit Turn
  assigned_user          text,
  primary_resident       text,
  primary_resident_phone text,
  scheduled_start        date,
  scheduled_end          date,
  created_at_appfolio    timestamptz,
  synced_at              timestamptz default now(),
  updated_at             timestamptz default now()
);

create index if not exists mwo_property_idx on maintenance_work_orders (property_name);
create index if not exists mwo_status_idx   on maintenance_work_orders (status);
create index if not exists mwo_assigned_idx on maintenance_work_orders (assigned_user);
