-- 031_online_shop_scorecard.sql
--
-- The BD CRM Online Shop tab now uses the full Online Response Scorecard (ported
-- from the original standalone tool) instead of a manually typed score. All the
-- scorecard answers/ratings/follow-up live in one JSONB column; the derived
-- percentage continues to go in the existing online_shops.score column.
--
-- Shape of scorecard:
--   { answers:{google_direct,form_ease,auto_ack,response_received,response_time,cta_tour},
--     ratings:{personalization}, rnotes:{<criterion>:text},
--     followup:{ within24, attempts, lastDays, channels:{call,text,email}, notes } }
--
-- Idempotent. Run in the Supabase SQL editor.

alter table online_shops add column if not exists scorecard jsonb;
