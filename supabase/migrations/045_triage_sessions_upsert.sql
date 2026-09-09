-- 045_triage_sessions_upsert.sql
--
-- POST /api/triage/log-session now UPSERTs on session_date (one row per day), so
-- re-logging a day updates in place instead of duplicating or failing. That needs
-- a UNIQUE constraint on session_date, and two category columns the newer triage
-- tool reports (financial, archive_and_mark_read).
--
-- Idempotent. Run in the Supabase SQL editor.

alter table triage_sessions add column if not exists financial             integer default 0;
alter table triage_sessions add column if not exists archive_and_mark_read integer default 0;

-- Unique on session_date so ON CONFLICT (session_date) has a target. Guarded so a
-- re-run (or a pre-existing constraint) doesn't error. If duplicate session_date
-- rows already exist they must be de-duped first (see the note below).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'triage_sessions_session_date_key'
  ) then
    alter table triage_sessions
      add constraint triage_sessions_session_date_key unique (session_date);
  end if;
end $$;

-- If the ALTER above fails because duplicate session_date rows already exist,
-- collapse them to the newest per day first, then re-run this file:
--   delete from triage_sessions a using triage_sessions b
--   where a.session_date = b.session_date and a.ctid < b.ctid;
