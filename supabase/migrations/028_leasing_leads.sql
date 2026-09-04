-- 028_leasing_leads.sql
--
-- Guest Card Interests leads, synced from AppFolio's "Guest Card Interests"
-- Joined Report (report id 6610f13d-95ae-11f0-a6a2-063f6f7015b5). Replaces the
-- manual weekly Excel export/import for the Weekly Leasing Goal Board: Katie
-- picks a date range and syncs; the KPI roll-ups read from this table.
--
-- One row per lead, de-duplicated by appfolio_id. AppFolio's Guest Card
-- Interests report has no native row id, so appfolio_id is a stable composite
-- of Name + Phone + Interest Received (built server-side on upsert).
--
-- Idempotent. Run in the Supabase SQL editor.

create table if not exists leasing_leads (
  id                uuid primary key default gen_random_uuid(),
  appfolio_id       text unique,          -- Name|Phone|Interest_Received composite
  name              text,
  email             text,
  phone             text,
  interest_received timestamptz,
  last_activity_date date,
  last_activity_type text,
  move_in_preference date,
  lisa_lead         boolean default false,
  source            text,
  property          text,
  assigned_user     text,
  notes             text,
  week_ending       date,                 -- Saturday of the Sun–Sat week interest_received falls in
  synced_at         timestamptz default now(),
  created_at        timestamptz default now()
);

create index if not exists leasing_leads_property_idx          on leasing_leads (property);
create index if not exists leasing_leads_week_idx              on leasing_leads (week_ending);
create index if not exists leasing_leads_interest_received_idx on leasing_leads (interest_received);
