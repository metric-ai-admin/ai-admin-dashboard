-- 073_activity_log.sql
--
-- Who used the dashboard, and what they changed.
--
-- WHAT IS DELIBERATELY NOT IN HERE. No request bodies, no query strings, no
-- resident names, no amounts, no note text. A row says WHICH KIND of thing was
-- touched and WHICH ONE, never what it said. The table is read by admin and the
-- CEO, and a column that quietly accumulated resident PII would be a different
-- and much worse table than the one anybody agreed to.
--
-- Phase 1 writes 'login', 'logout' and 'write'. 'view' is in the CHECK and in
-- the unique index from the start so phase 2 needs no migration — the column
-- stays null until something fills it.
create table if not exists activity_log (
  id          bigserial primary key,
  at          timestamptz not null default now(),

  -- Identity comes off the JWT, which already carries all of this on every
  -- authenticated request. user_name and user_role are copied rather than
  -- joined so a report still reads correctly after somebody's role changes:
  -- the row records who they were AT THE TIME, not who they are now.
  user_email  text not null,
  user_name   text,
  user_role   text,

  event       text not null,
  section     text,                 -- 'tasks', 'leasing', 'crm', 'marketing', …
  resource    text,                 -- the id in the route, never its contents
  method      text,                 -- writes only
  status_code integer,

  constraint activity_log_event_chk
    check (event in ('login', 'logout', 'view', 'write'))
);

create index if not exists activity_log_at_idx      on activity_log (at desc);
create index if not exists activity_log_user_idx    on activity_log (user_email, at desc);
create index if not exists activity_log_section_idx on activity_log (section, at desc);

-- ── View de-duplication (phase 2) ───────────────────────────────────────────
--
-- One row per user per section per 30-minute bucket. Half an hour spent in
-- Leasing is one row, not forty clicks.
--
-- The uniqueness lives HERE rather than in the client or the logger, because
-- those are the two places it would quietly stop working: a retried beacon, a
-- second browser tab or a restarted process all defeat an in-memory guard. The
-- index cannot be defeated by any of them.
alter table activity_log add column if not exists view_bucket timestamptz;

create unique index if not exists activity_log_view_uniq
  on activity_log (user_email, section, view_bucket)
  where event = 'view';

-- ── Retention ───────────────────────────────────────────────────────────────
--
-- 90 days, swept nightly by the existing cron. At ~12 users this is of the
-- order of 40,000 rows at steady state.
--
--   delete from activity_log where at < now() - interval '90 days';

-- Verify:
--
--   select event, count(*) from activity_log group by event;
--   select user_email, max(at) last_seen from activity_log
--    group by user_email order by last_seen desc;
