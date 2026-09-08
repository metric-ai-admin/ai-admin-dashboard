-- 040_leasing_tours_apps_moveins.sql
--
-- Phase 5b — the three remaining Goal Board data sources, synced from AppFolio's
-- Reports API: Showings (Tours), Rental Applications, and Lease History (Move-ins).
-- Field names verified live via the (now-removed) /raw debug endpoints.
-- property_name stores the clean community name (substring before " - ").
--
-- Idempotent. Run in the Supabase SQL editor.

create table if not exists leasing_showings (
  id            uuid primary key default gen_random_uuid(),
  showing_id    integer unique,          -- AppFolio showing_id (upsert key)
  property_name text,
  property_id   integer,
  showing_date  date,                    -- date parsed from showing_time
  unit          text,
  prospect      text,
  status        text,                    -- Prospect Confirmed / Completed / Canceled / No Show
  type          text,                    -- In-Person / Virtual
  synced_at     timestamptz default now()
);
create index if not exists ls_date_idx on leasing_showings (showing_date);
create index if not exists ls_prop_idx on leasing_showings (property_id);

create table if not exists leasing_applications (
  id                    uuid primary key default gen_random_uuid(),
  rental_application_id integer unique,   -- AppFolio rental_application_id (upsert key)
  property_name         text,
  property_id           integer,
  application_date      date,             -- date parsed from received
  status                text,            -- Approved / Denied / Pending / Canceled / Converted
  move_in_date          date,
  synced_at             timestamptz default now()
);
create index if not exists la_date_idx on leasing_applications (application_date);
create index if not exists la_prop_idx on leasing_applications (property_id);

create table if not exists leasing_lease_history (
  id            uuid primary key default gen_random_uuid(),
  lease_uuid    text unique,             -- AppFolio lease_uuid (upsert key)
  property_name text,
  property_id   integer,
  move_in_date  date,
  move_out_date date,
  status        text,                    -- Completed / Current / Future
  renewal       text,                    -- Yes / No
  tenant_name   text,
  synced_at     timestamptz default now()
);
create index if not exists llh_movein_idx on leasing_lease_history (move_in_date);
create index if not exists llh_prop_idx on leasing_lease_history (property_id);
