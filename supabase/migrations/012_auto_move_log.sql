-- Email Auto-Move — Phase 1
--
-- Approved by Lyndsay in standup 2026-08-31. Phase 1 performs exactly two
-- automatic actions on NEW mail arriving in Lyndsay's Inbox:
--   1. archive + mark read  — 1:1 cold outreach from a confirmed sender
--   2. move to "Unsubscribe Needed", left unread — anything carrying a
--      List-Unsubscribe header
-- Everything else is left alone for manual triage. Lyndsay Review, Client
-- Emails, MPM Team, Financial, Bekah Follow Up, Rocio and Personal are never
-- written to in this phase.
--
-- Run in the Supabase SQL editor. Every statement is IF NOT EXISTS / ON
-- CONFLICT and safe to re-run; the editor does not honour BEGIN/COMMIT.

-- ---------------------------------------------------------------------------
-- Who counts as confirmed cold outreach.
--
-- The brief says to use "the senders already confirmed in cold_outreach_senders,
-- or a hardcoded list of the ones we already have". Neither exists. There is no
-- cold_outreach_senders table, and triage_sessions — the only triage history we
-- keep — stores COUNTS per session (archive: 12, unsubscribe: 5) and never a
-- single sender address. So the list has to be built before Phase 1 can archive
-- anything, and it starts empty here on purpose.
--
-- A table rather than a constant in server.js: confirming a new cold-outreach
-- sender should be a row, not a deploy, and the same reasoning that kept the
-- G&B agents out of the code applies to Lyndsay's correspondents.
-- ---------------------------------------------------------------------------
create table if not exists cold_outreach_senders (
  id            uuid primary key default gen_random_uuid(),
  -- Full address, lowercased. Exact match only in Phase 1 — no domain
  -- wildcards, because @gmail.com would swallow real clients.
  sender_email  text not null unique,
  -- Free text: 'M&A advisory', 'cybersecurity lead gen', 'public adjuster'.
  -- Descriptive, never used for matching.
  category      text,
  -- Who approved it and when, so a bad archive can be traced to a decision.
  confirmed_by  text not null default 'arturo',
  confirmed_at  timestamptz not null default now(),
  -- Deactivate instead of deleting: the log references senders by address and
  -- the history should stay readable.
  active        boolean not null default true,
  notes         text
);

create index if not exists cold_outreach_senders_active_idx
  on cold_outreach_senders (sender_email) where active;

-- ---------------------------------------------------------------------------
-- What the automation did.
--
-- One row per action taken. Also the undo record: every column needed to put a
-- message back is here, because the failure mode that matters is a real email
-- silently archived and marked read.
-- ---------------------------------------------------------------------------
create table if not exists auto_move_log (
  id          uuid primary key default gen_random_uuid(),

  -- Graph's message id. NOT stable: it changes when a message moves between
  -- folders, so this is the id as it was BEFORE the move — good for the undo
  -- call, useless as a dedupe key.
  email_id    text not null,

  -- RFC 5322 Message-ID. Immutable across folder moves, which makes it the
  -- real "have we already handled this?" key. Unique so a cron overlapping
  -- with itself, or a retry after a partial failure, cannot act twice.
  internet_message_id text unique,

  subject     text,
  sender      text,

  -- 'archive_read' | 'move_unsubscribe'
  action      text not null,

  -- Why it fired: the sender address for archive_read, 'List-Unsubscribe' for
  -- move_unsubscribe. Without this the log says what happened but not why.
  matched_on  text,

  -- Kept because the spec asks for it. In Phase 1 it is always 1.0 — matching
  -- is an exact-address lookup plus a header presence check, so there is no
  -- estimate being made. It becomes meaningful when Phase 2 classifies.
  confidence  numeric(4,3) not null default 1.0,

  -- Where it went, for the undo path and for spotting a misrouted folder.
  target_folder text,

  -- Set when the Graph call failed; the row is still written so a silently
  -- broken automation cannot look like a quiet day.
  error       text,

  -- true when the run was a dry run: matched and logged, nothing moved.
  dry_run     boolean not null default false,

  executed_at timestamptz not null default now(),

  -- Stamped when a human reverses the action. Phase 1 does not build the undo
  -- UI; the column exists so a manual reversal can be recorded from day one.
  undone_at   timestamptz,
  undone_by   text
);

create index if not exists auto_move_log_executed_idx on auto_move_log (executed_at desc);
create index if not exists auto_move_log_action_idx   on auto_move_log (action, executed_at desc);
-- Partial index over the rows anyone actually goes looking for.
create index if not exists auto_move_log_error_idx    on auto_move_log (executed_at desc) where error is not null;

-- Check — what the automation did today:
-- select executed_at, action, matched_on, sender, subject, dry_run, error
-- from auto_move_log where executed_at > current_date order by executed_at desc;
--
-- Check — the allowlist:
-- select sender_email, category, confirmed_by, active from cold_outreach_senders order by sender_email;
