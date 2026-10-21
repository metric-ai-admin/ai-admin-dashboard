-- 113 — every night the auto-grade ran, including the nights it failed.
--
-- The grader stopped on 2026-10-17 after three calls and nobody knew until
-- 2026-10-21, when Kara's brief said "no calls were graded" for the fourth
-- morning running. The Anthropic balance had run out; the recordings were
-- arriving the whole time.
--
-- WHY IT WENT UNSEEN FOR FOUR DAYS. There was no record of a run. The cron
-- wrote a line to Render's log, which nobody reads, and the only trace of
-- grading was the grades themselves — so a night that produced nothing left
-- nothing behind, and "the cron did not run" and "the cron ran and every call
-- failed" looked exactly alike. Working out which it was meant reading the
-- timestamps of rows that happened to get written before it broke.
--
-- A row here per attempt is what makes a blank night visible.

create table if not exists autograde_runs (
  id          bigserial primary key,
  -- The night it ran, and the day it was grading (yesterday).
  ran_at      timestamptz not null default now(),
  for_day     date not null,

  -- What there was to do, and what happened to it.
  eligible    integer not null default 0,
  graded      integer not null default 0,
  already     integer not null default 0,
  skipped     integer not null default 0,
  errors      integer not null default 0,

  -- WHY it failed, classified rather than left as a 400.
  --
  -- 'credit'  the balance is spent — top up
  -- 'auth'    the key is wrong or revoked — replace it
  -- 'rate'    throttled — it will likely pass next time
  -- 'other'   something else, with the message
  -- null      nothing failed
  --
  -- Three different problems with three different answers, which the API
  -- reports as three different HTTP codes and which the dashboard reported as
  -- "Anthropic API error" for all of them.
  failure_kind text,
  failure_note text,

  -- Whether an alert went out for this run, so a repeated failure does not
  -- send the same mail every night and train its reader to delete it.
  alerted     boolean not null default false,

  source      text not null default 'cron'   -- 'cron' | 'backfill' | 'manual'
);

create index if not exists autograde_runs_day_idx on autograde_runs (for_day desc);
create index if not exists autograde_runs_ran_idx on autograde_runs (ran_at desc);

comment on table autograde_runs is
  'One row per auto-grade attempt. A day with no row is a night nobody ran — which is a different fact from a night that ran and graded nothing.';
comment on column autograde_runs.failure_kind is
  'credit | auth | rate | other. The answer differs for each, and the API reports them as different status codes.';

-- GRANTS IN THE SAME MIGRATION (the rule from 112 onward).
--
-- service_role only: nothing in public/ talks to Supabase — every read and
-- write goes through an Express route holding the service-role key — so
-- `authenticated` would grant a client that does not exist and `anon` is the
-- public internet.
grant all privileges on table autograde_runs to service_role;
-- bigserial is a sequence, and a grant on the table does not reach it: the
-- insert would fail on nextval() with the table perfectly readable.
grant usage, select on sequence autograde_runs_id_seq to service_role;

-- Verify:
--   select for_day, ran_at, eligible, graded, errors, failure_kind, alerted
--     from autograde_runs order by ran_at desc limit 10;
