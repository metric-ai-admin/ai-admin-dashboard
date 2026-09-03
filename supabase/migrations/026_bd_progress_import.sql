-- 026_bd_progress_import.sql
--
-- Historical BD Progress migration from Lyndsay's CRM tool. These are dedicated
-- ARCHIVE tables that mirror the exported Excel structure exactly, keyed by the
-- export's own ID so re-importing the same file upserts instead of duplicating.
--
-- Deliberately SEPARATE from the live CRM tables (properties / phone_shops /
-- online_shops / dm_reviews / follow_ups): the export's columns differ from the
-- live schema and use text ids (e.g. call_ms9e195pek3ck) rather than uuids, so
-- importing into the live tables would be lossy and risk the live data. Nothing
-- here touches the existing CRM tables or UI — purely additive. Each row also
-- carries the fuzzy-matched live property_id (nullable) so the archive can be
-- linked back to a property when a name matches.
--
-- Idempotent. Run in the Supabase SQL editor.

create table if not exists bd_phone_shops (
  id             uuid primary key default gen_random_uuid(),
  external_id    text unique,            -- export "ID" (dedupe key)
  property       text,                   -- export "Property" (raw name)
  property_id    uuid,                   -- fuzzy match to properties.id (nullable)
  shop_date      date,
  shop_time      text,
  agent          text,
  caller         text,
  connection     text,
  appt_set       text,
  appt_datetime  text,
  appt_follow_up text,
  recording      text,
  call_score     numeric,
  notes          text,
  imported_at    timestamptz default now(),
  updated_at     timestamptz default now()
);

create table if not exists bd_online_shops (
  id           uuid primary key default gen_random_uuid(),
  external_id  text unique,
  property     text,
  property_id  uuid,
  shop_date    date,
  shop_time    text,
  website      text,
  contact_type text,
  score        numeric,
  notes        text,
  imported_at  timestamptz default now(),
  updated_at   timestamptz default now()
);

-- DM Reviews export has no ID column — one row per property, so property is the key.
create table if not exists bd_dm_reviews (
  id            uuid primary key default gen_random_uuid(),
  property      text unique,
  property_id   uuid,
  overall_score numeric,
  complete      text,
  last_updated  text,
  imported_at   timestamptz default now(),
  updated_at    timestamptz default now()
);

create table if not exists bd_follow_ups (
  id              uuid primary key default gen_random_uuid(),
  external_id     text unique,
  property        text,
  property_id     uuid,
  follow_up_date  date,
  type            text,
  outcome         text,
  imported_at     timestamptz default now(),
  updated_at      timestamptz default now()
);

-- Property Edits export has no ID column — keyed by property. Archived here
-- rather than mutating the live properties table (additive-only).
create table if not exists bd_property_edits (
  id                  uuid primary key default gen_random_uuid(),
  property            text unique,
  property_id         uuid,
  mgmt_co             text,
  mgmt_type           text,
  owner               text,
  overridden_fields   text,
  notes               text,
  mutual_connection   text,
  reviewed_by_lyndsay text,
  owner_responded     text,
  imported_at         timestamptz default now(),
  updated_at          timestamptz default now()
);

create index if not exists bd_phone_shops_prop_idx  on bd_phone_shops (property_id);
create index if not exists bd_online_shops_prop_idx on bd_online_shops (property_id);
create index if not exists bd_follow_ups_prop_idx   on bd_follow_ups (property_id);
