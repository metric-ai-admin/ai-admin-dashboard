-- 043_daily_calls_user_direction.sql
--
-- The 6 PM archive now iterates every roster user (not just the default line), so
-- simplevoip_daily_calls records which Metric line owner the call belongs to and
-- its direction. auto-grade reads user_name as the line-owner fallback for agent
-- attribution and call_direction for the grade. Still upserted on recording_id,
-- so a call shared by a ring group stays a single row.
--
-- Idempotent. Run in the Supabase SQL editor.

alter table simplevoip_daily_calls add column if not exists user_name     text;
alter table simplevoip_daily_calls add column if not exists call_direction text;
