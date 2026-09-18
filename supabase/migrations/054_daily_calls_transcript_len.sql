-- 054_daily_calls_transcript_len.sql
--
-- A stored transcript length, so the grading floor can be applied in SQL.
--
-- autoGradeDay() skips a call whose transcript is under AUTOGRADE_MIN_TRANSCRIPT
-- (100 characters), but that floor could not be expressed in a PostgREST filter,
-- so it was applied in JavaScript after the rows came back. Anything else that
-- needed the same definition — /api/calls/grade-progress, most visibly — either
-- omitted the floor and counted calls that will never grade, or had to download
-- every transcript to measure it. Measured on 2026-09-18: 2,259 KB per request,
-- to produce three integers.
--
-- A generated column makes the floor a queryable property. Postgres backfills
-- existing rows when the column is added and maintains it on write, so nothing
-- has to remember to populate it.
--
-- btrim matches the JS side, which compares String(transcript).trim().length.
-- A NULL transcript yields NULL, not 0 — the callers treat both as below the
-- floor, and coalescing here would hide the difference between "no transcript"
-- and "empty transcript".
--
-- Idempotent. Run in the Supabase SQL editor.

alter table simplevoip_daily_calls
  add column if not exists transcript_len integer
  generated always as (length(btrim(transcript))) stored;

-- The progress counter filters on duration and this together.
create index if not exists simplevoip_daily_calls_gradeable_idx
  on simplevoip_daily_calls (duration, transcript_len);

-- Check — these three should match what the Call Analyzer header shows:
--   select count(*) filter (where duration >= 30 and transcript_len >= 100) as eligible,
--          count(*) filter (where duration <  30 or  coalesce(transcript_len,0) < 100) as below_floor,
--          count(*) as archived
--   from simplevoip_daily_calls;
