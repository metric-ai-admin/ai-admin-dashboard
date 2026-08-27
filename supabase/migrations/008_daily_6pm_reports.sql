-- Daily 6 PM Report — Lyndsay's end-of-day roll-up
--
-- Spec confirmed 2026-08-17: the day's meetings in three categories, action
-- items pulled from their transcripts, and a snapshot of Lyndsay's inbox at the
-- moment the report runs. WhatsApp delivery is a later step.
--
-- Run in the Supabase SQL editor. Every statement is IF NOT EXISTS and safe to
-- re-run; the editor does not honour BEGIN/COMMIT.

create table if not exists daily_6pm_reports (
  id             uuid primary key default gen_random_uuid(),
  report_date    date not null,
  meetings       jsonb not null default '[]'::jsonb,
  action_items   jsonb not null default '[]'::jsonb,
  inbox_snapshot jsonb not null default '{}'::jsonb,
  -- Records which inputs were actually available on the run. Transcripts and
  -- action-item extraction each depend on something that is not in place yet,
  -- and a reader needs to tell "nothing happened today" from "we could not
  -- look" — see the notes at the end of this file.
  sources        jsonb not null default '{}'::jsonb,
  generated_at   timestamptz not null default now()
);

-- One report per day. A 6 PM cron and a "Generate Now" button both write here,
-- and without this a manual run beside the scheduled one would leave two
-- versions of the same evening with nothing to say which was read.
create unique index if not exists daily_6pm_reports_date_key
  on daily_6pm_reports (report_date);

-- /latest orders by this.
create index if not exists daily_6pm_reports_generated_idx
  on daily_6pm_reports (generated_at desc);

-- ---------------------------------------------------------------------------
-- Two inputs in the spec are not reachable from this server yet. The report
-- generates and stores everything else, and sources says what was missing:
--
--   meetings.transcript — Teams transcripts need the OnlineMeetingTranscript
--     .Read.All APPLICATION permission with admin consent, plus a Teams
--     application access policy (New-CsApplicationAccessPolicy) granting this
--     app access to Lyndsay's meetings. GRAPH_SCOPES currently holds only
--     Mail.Read, Mail.Read.Shared, Calendars.Read, Calendars.Read.Shared.
--
--   action_items — extraction needs an Anthropic API key on the server. There
--     is none; COPILOT_API_KEY is an inbound key guarding a route for external
--     callers, not a key this server can call out with.
--
-- Both drop into the existing shape once available — no schema change.
-- ---------------------------------------------------------------------------

-- Check:
-- select report_date, jsonb_array_length(meetings) meetings,
--        jsonb_array_length(action_items) actions, sources, generated_at
-- from daily_6pm_reports order by report_date desc;
