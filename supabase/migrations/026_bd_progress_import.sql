-- 026_bd_progress_import.sql
--
-- Historical BD Progress migration from Lyndsay's CRM tool. Dedicated ARCHIVE
-- tables that mirror the exported Excel structure, keyed for idempotent upsert so
-- re-importing the same file updates rows in place instead of duplicating.
--
-- Deliberately SEPARATE from the live CRM tables (properties / phone_shops /
-- online_shops / dm_reviews / follow_ups). Nothing here touches them — purely
-- additive. Each row also carries the fuzzy-matched live property_id (nullable).
--
-- Phone Shops, Online Shops and Follow-Ups dedupe on the export's own ID
-- (external_id). DM Reviews and Property Edits have no ID column and are one row
-- per property PER AGENT (each agent exports their own file), so they dedupe on
-- (property, agent). Idempotent; run in the Supabase SQL editor.

create table if not exists bd_phone_shops (
  id             uuid primary key default gen_random_uuid(),
  external_id    text unique,            -- export "ID" (dedupe key)
  property       text,
  property_id    uuid,
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

-- DM Reviews: no ID column — one row per (property, agent).
create table if not exists bd_dm_reviews (
  id            uuid primary key default gen_random_uuid(),
  property      text,
  agent         text,
  property_id   uuid,
  overall_score numeric,
  complete      text,
  last_updated  text,
  imported_at   timestamptz default now(),
  updated_at    timestamptz default now(),
  unique (property, agent)
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

-- Property Edits: no ID column — one row per (property, agent). Archived here
-- rather than mutating the live properties table (additive-only).
create table if not exists bd_property_edits (
  id                  uuid primary key default gen_random_uuid(),
  property            text,
  agent               text,
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
  updated_at          timestamptz default now(),
  unique (property, agent)
);

-- ── Reconcile tables that already exist (e.g. created by an earlier draft that
-- used property-only uniques and different column names). All idempotent.
alter table bd_phone_shops    add column if not exists agent          text;
alter table bd_phone_shops    add column if not exists appt_follow_up text;
alter table bd_phone_shops    add column if not exists updated_at     timestamptz default now();
alter table bd_online_shops   add column if not exists updated_at     timestamptz default now();
alter table bd_dm_reviews     add column if not exists agent          text;
alter table bd_dm_reviews     add column if not exists overall_score  numeric;
alter table bd_dm_reviews     add column if not exists updated_at     timestamptz default now();
alter table bd_follow_ups     add column if not exists follow_up_date date;
alter table bd_follow_ups     add column if not exists type           text;
alter table bd_follow_ups     add column if not exists updated_at     timestamptz default now();
alter table bd_property_edits add column if not exists agent          text;
alter table bd_property_edits add column if not exists updated_at     timestamptz default now();

-- Drop the old property-only uniques from the first draft, if present.
alter table bd_dm_reviews     drop constraint if exists bd_dm_reviews_property_key;
alter table bd_property_edits drop constraint if exists bd_property_edits_property_key;

-- Ensure the composite (property, agent) unique exists — add it only if no unique
-- on exactly those two columns is already present (so a hand-created one isn't
-- duplicated).
do $$
begin
  if not exists (
    select 1 from pg_constraint c
    where c.conrelid = 'bd_dm_reviews'::regclass and c.contype = 'u'
      and (select array_agg(a.attname order by a.attname)
             from unnest(c.conkey) k join pg_attribute a
               on a.attrelid = c.conrelid and a.attnum = k) = array['agent','property']
  ) then
    alter table bd_dm_reviews add constraint bd_dm_reviews_property_agent_key unique (property, agent);
  end if;
  if not exists (
    select 1 from pg_constraint c
    where c.conrelid = 'bd_property_edits'::regclass and c.contype = 'u'
      and (select array_agg(a.attname order by a.attname)
             from unnest(c.conkey) k join pg_attribute a
               on a.attrelid = c.conrelid and a.attnum = k) = array['agent','property']
  ) then
    alter table bd_property_edits add constraint bd_property_edits_property_agent_key unique (property, agent);
  end if;
end $$;

create index if not exists bd_phone_shops_prop_idx  on bd_phone_shops (property_id);
create index if not exists bd_online_shops_prop_idx on bd_online_shops (property_id);
create index if not exists bd_follow_ups_prop_idx   on bd_follow_ups (property_id);
