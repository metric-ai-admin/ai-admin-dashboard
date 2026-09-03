-- 025_meeting_summaries.sql
--
-- Teams meeting transcripts, summarized. One row per captured transcript,
-- de-duplicated by transcript_id (Graph's stable transcript id) so the polling
-- capture job never double-inserts. Summary + action items are always stored;
-- the raw transcript_text is optional context (retention to be decided).
--
-- Idempotent. Run in the Supabase SQL editor.

create table if not exists meeting_summaries (
  id             uuid primary key default gen_random_uuid(),
  meeting_id     text,                         -- Graph onlineMeeting id
  transcript_id  text unique,                  -- Graph transcript id (dedupe key)
  join_url       text,
  subject        text,
  category       text,
  meeting_date   date,                          -- Central-time date of the meeting
  start_at       timestamptz,
  end_at         timestamptz,
  organizer      text,
  attendees      jsonb default '[]'::jsonb,
  key_decisions  jsonb default '[]'::jsonb,
  action_items   jsonb default '[]'::jsonb,     -- [{ action, owner }]
  summary        text,
  transcript_text text,
  source         text default 'teams',
  status         text default 'summarized',     -- 'summarized' | 'no_transcript' | 'error'
  error          text,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

create index if not exists meeting_summaries_date_idx on meeting_summaries (meeting_date);
