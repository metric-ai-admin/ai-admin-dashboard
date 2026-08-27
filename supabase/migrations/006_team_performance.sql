-- BD CRM Phase C · Module 1 — Team Performance
--
-- Attribution columns. Only phone_shops recorded who did the work; every other
-- activity table stored what happened without saying by whom, so per-agent
-- numbers could not be produced from them at all.
--
-- Run in the Supabase SQL editor. Every statement is IF NOT EXISTS and safe to
-- re-run — the editor does not honour BEGIN/COMMIT, which is what cost us rows
-- during the property dedup.
--
-- Note: dm_reviews and these columns are not described by migrations 001-005.
-- The production schema had already drifted from this directory; this file is
-- written against the schema as it actually is, confirmed by querying
-- information_schema before writing it.

alter table online_shops    add column if not exists agent_name text;
alter table follow_ups      add column if not exists agent_name text;
alter table dm_reviews      add column if not exists agent_name text;

-- outreach_drafts is deliberately untouched: approved_by already identifies a
-- person. It names the approver rather than the author, which is a different
-- question, but adding a second name column to answer it is not this change.

-- Indexed on (agent, date) because that is exactly the shape of every query the
-- panel makes: one agent, one period. Partial on agent_name so the index does
-- not carry the entire backlog of rows written before attribution existed.
create index if not exists online_shops_agent_date_idx
  on online_shops (agent_name, shop_date) where agent_name is not null;
create index if not exists follow_ups_agent_date_idx
  on follow_ups (agent_name, follow_up_date) where agent_name is not null;
create index if not exists dm_reviews_agent_date_idx
  on dm_reviews (agent_name, updated_at) where agent_name is not null;

-- phone_shops already has agent_name; it was missing the index.
create index if not exists phone_shops_agent_date_idx
  on phone_shops (agent_name, shop_date) where agent_name is not null;

-- Existing rows keep agent_name null on purpose. Backfilling from the property's
-- phone_assignee would attribute the work to whoever is configured on the
-- property rather than whoever did it, and every property carries the same two
-- names — it would invent a history rather than record one. The panel reports
-- these metrics as untracked until real rows accumulate.

-- Check:
-- select 'online_shops' t, count(*) total, count(agent_name) attributed from online_shops
-- union all select 'follow_ups', count(*), count(agent_name) from follow_ups
-- union all select 'dm_reviews', count(*), count(agent_name) from dm_reviews
-- union all select 'phone_shops', count(*), count(agent_name) from phone_shops;
