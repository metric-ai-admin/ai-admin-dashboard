-- SimpleVOIP — daily call archive
--
-- SimplyAI keeps transcripts on ajax.simplevoip.us, which answers with no
-- authentication at all and gives no guarantee about how long an analysis
-- stays available. A 6 PM job copies the day into our own store so the record
-- survives whatever the vendor does with it.
--
-- Run in the Supabase SQL editor. Every statement is IF NOT EXISTS and safe to
-- re-run; the editor does not honour BEGIN/COMMIT.

create table if not exists simplevoip_daily_calls (
  id           uuid primary key default gen_random_uuid(),
  call_date    date not null,
  recording_id text not null,
  caller       text,
  duration     int,
  transcript   text,
  fetched_at   timestamptz not null default now()
);

-- Upserted on recording_id, so re-running the job — or running it by hand after
-- the cron already fired — refreshes rows instead of duplicating the day.
-- recording_id is the only id that means the same thing on both SimpleVOIP
-- endpoints: call_id differs between them for the same call.
create unique index if not exists simplevoip_daily_calls_recording_key
  on simplevoip_daily_calls (recording_id);

-- The Call Analyzer reads one day at a time.
create index if not exists simplevoip_daily_calls_date_idx
  on simplevoip_daily_calls (call_date desc);

-- ---------------------------------------------------------------------------
-- Only calls that actually have an analysis are stored. A missed call carries
-- an empty recording_id and no transcript, and rows keyed on an empty string
-- would collide with each other on the unique index above. Roughly 60% of the
-- calls in a day qualify — 12 of 20 on 2026-08-26.
--
-- Transcripts are conversations with residents. This table is resident PII and
-- should be treated as such: the routes that read it are session-gated, and it
-- is not exposed to the MCP tools.
-- ---------------------------------------------------------------------------

-- Check:
-- select call_date, count(*), min(fetched_at) from simplevoip_daily_calls
-- group by call_date order by call_date desc;
