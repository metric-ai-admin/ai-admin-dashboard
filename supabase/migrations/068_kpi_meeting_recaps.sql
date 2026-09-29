-- 068_kpi_meeting_recaps.sql
--
-- KPI RR Automation. After each Round Rock KPI meeting (ICRR / ICDT) the
-- recording and transcript go to the Round Rock partners — as a DRAFT that
-- Arturo approves. Nothing sends itself. Requested by Lyndsay 2026-09-16.
--
-- WHAT THE TENANT ACTUALLY DOES, verified read-only on 2026-09-29 after the two
-- permissions landed. Every column below exists because of one of these:
--
--   * THE WHOLE SERIES SHARES ONE onlineMeeting. Its join URL is fixed, so
--     /transcripts and /recordings return all twenty past occurrences at once,
--     oldest 2026-02-25, newest 2026-09-23. A row here is ONE occurrence, and
--     the ids below are what separate it from the other nineteen.
--   * contentCorrelationId PAIRS a transcript with the recording of the same
--     call. Matching on createdDateTime would work most days and fail the day
--     someone starts a second recording, so the correlation id is what this
--     stores and matches on.
--   * The organizer is officecalendar@metricpropertymanagement.com, NOT
--     Lyndsay. That is why this needed its own Teams application access policy
--     grant, and why organizer_id is recorded rather than assumed.
--
-- DRAFT MODE IS THE POINT. proposed_to is what the calendar says; final_to is
-- what actually went out. They are separate columns so that "did the automatic
-- recipient list need correcting?" is a query, not a memory. Automatic sending
-- stays off until Lyndsay confirms the list, and until then approved_at can be
-- set while sent_at stays null — approval and delivery are not the same event.
--
-- Run in the Supabase SQL editor BEFORE deploying the code that writes it.
-- Idempotent and safe to re-run.

create table if not exists kpi_meeting_recaps (
  id                     uuid primary key default gen_random_uuid(),

  -- WHICH occurrence. The correlation id is the natural key: one per call,
  -- shared by that call's transcript and recording.
  content_correlation_id text not null,
  online_meeting_id      text not null,
  organizer_id           text not null,
  transcript_id          text,
  recording_id           text,

  subject                text not null,
  meeting_date           date not null,
  started_at             timestamptz,
  ended_at               timestamptz,

  -- External attendees from the invitation, and who it was actually sent to.
  -- Kept apart on purpose: a gap between them is the signal that the automatic
  -- list is not yet trustworthy, and the reason auto-send is off.
  proposed_to            text[] not null default '{}',
  final_to               text[] not null default '{}',

  -- Held back pending Lyndsay's confirmation. Recorded rather than dropped so
  -- the decision is visible and reversible without re-deriving it.
  excluded               text[] not null default '{}',

  summary                text,
  transcript_text        text,
  speakers               text[] not null default '{}',
  -- A Graph URL, not a public link. Turning it into something a partner can
  -- open is a separate step that happens at approval, if the tenant allows
  -- external sharing at all.
  recording_url          text,

  email_subject          text,
  email_body             text,

  -- draft -> approved -> sent. skipped and failed are terminal.
  status                 text not null default 'draft',
  approved_by            text,
  approved_at            timestamptz,
  sent_at                timestamptz,
  error                  text,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint kpi_meeting_recaps_status_chk
    check (status in ('draft', 'approved', 'sent', 'skipped', 'failed')),

  -- One draft per call. Re-running the scan updates the row instead of filling
  -- the dashboard with duplicates of the same meeting.
  constraint kpi_meeting_recaps_call_uniq unique (content_correlation_id)
);

-- "What is waiting for me to approve?" — the one read the dashboard makes.
create index if not exists kpi_meeting_recaps_status_idx
  on kpi_meeting_recaps (status, meeting_date desc);

-- Verify, after the first scan:
--
--   select meeting_date, status, array_length(proposed_to, 1) as recipients,
--          recording_id is not null as has_recording,
--          length(transcript_text) as transcript_chars
--     from kpi_meeting_recaps
--    order by meeting_date desc;
--
-- The most recent occurrence at the time of writing is 2026-09-23, 17:59-18:23
-- UTC, with both a transcript (16,544 characters) and a recording.
--
-- And the question that decides whether auto-send is ever safe to switch on:
--
--   select count(*) filter (where final_to <> proposed_to) as corrected,
--          count(*) filter (where status = 'sent')         as sent
--     from kpi_meeting_recaps;
