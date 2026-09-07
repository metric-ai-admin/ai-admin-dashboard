-- 035_maintenance_support_reports.sql
--
-- The five supporting Command Center reports, synced from AppFolio's Reports API
-- into their own tables. Full-replaced on each sync (each report is a current
-- snapshot). Only the fields command-center.js actually reads for each slot are
-- stored:
--   insp  → ccInspectionTasks: name, property, unit, status, created_on,
--           marked_done_by, inspection_id
--   bill  → ccMergeWorkOrders/ccLaborLines: wo#, property, unit, vendor,
--           created, billable_type, description, hours, quantity, amount, unbilled
--   labor → ccLaborLines/ccHoursAudit + after-hours: wo#, date, tech, property,
--           unit, start/end time, worked hours, status, description, issue
--   cf    → ccMergeWorkOrders STATIC: wo#, wo id, sr id, code violation,
--           est. completion, life safety, parts needed
--   inv   → ccInvLines: item, wo#, status, property, unit, added_on, qty, cost,
--           sale price, category, location
--
-- Idempotent. Run in the Supabase SQL editor.

create table if not exists maintenance_inspections (
  id uuid primary key default gen_random_uuid(),
  inspection_id    text,
  inspection_name  text,
  property_name    text,
  unit             text,
  primary_resident text,
  status           text,
  inspection_date  date,
  marked_done_on   date,
  marked_done_by   text,
  created_on       date,
  property_id      text,
  synced_at        timestamptz default now()
);
create index if not exists mi_status_idx on maintenance_inspections (status);

create table if not exists maintenance_billable (
  id uuid primary key default gen_random_uuid(),
  work_order_number text,
  property          text,
  unit              text,
  vendor            text,
  created_date      date,
  billable_type     text,
  description       text,
  billable_hours    numeric,
  quantity          numeric,
  amount            numeric,
  billed_amount     numeric,
  unbilled_amount   numeric,
  synced_at         timestamptz default now()
);
create index if not exists mb_wo_idx on maintenance_billable (work_order_number);

create table if not exists maintenance_labor (
  id uuid primary key default gen_random_uuid(),
  work_order_number text,
  labor_date        date,
  maintenance_tech  text,
  property          text,
  unit              text,
  start_time        text,
  end_time          text,
  worked_hours      numeric,
  billable_hours    numeric,
  work_order_status text,
  description       text,
  work_order_issue  text,
  synced_at         timestamptz default now()
);
create index if not exists ml_wo_idx on maintenance_labor (work_order_number);

create table if not exists maintenance_custom_fields (
  id uuid primary key default gen_random_uuid(),
  work_order_number         text,
  work_order_id             text,
  service_request_id        text,
  code_violation            text,
  estimated_completion_time text,
  life_safety_issue         text,
  parts_needed              text,
  synced_at                 timestamptz default now()
);
create index if not exists mcf_wo_idx on maintenance_custom_fields (work_order_number);

create table if not exists maintenance_inventory (
  id uuid primary key default gen_random_uuid(),
  item_name          text,
  work_order_number  text,
  work_order_status  text,
  property           text,
  unit               text,
  inventory_added_on date,
  quantity           numeric,
  cost               numeric,
  sale_price         numeric,
  category           text,
  inventory_location text,
  synced_at          timestamptz default now()
);
create index if not exists minv_wo_idx on maintenance_inventory (work_order_number);
