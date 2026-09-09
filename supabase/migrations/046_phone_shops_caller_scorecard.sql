-- 046_phone_shops_caller_scorecard.sql
--
-- BD CRM Phone Shop form additions:
--   caller_name — the fake name the agent uses on the call (required per shop)
--   scorecard   — the "Perfect Phone Call" scorecard { rating, answers{} },
--                 saved only when the connection is "Answered by Agent"
-- Mirrors online_shops.scorecard (migration 031).
--
-- Idempotent. Run in the Supabase SQL editor.

alter table phone_shops add column if not exists caller_name text;
alter table phone_shops add column if not exists scorecard   jsonb;
