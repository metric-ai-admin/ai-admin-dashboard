-- 079_activity_actions.sql
--
-- Readable actions, and a way to stop the dashboard's own chatter being
-- counted as people working.
--
-- TWO PROBLEMS THIS FIXES.
--
-- 1. The Command Center saves its board on every page load, for EVERY user,
--    because command-center.js runs ccInit() on DOMContentLoaded whatever tab
--    you are on. Each load POSTed /api/maintenance/command-center/state, which
--    the write logger recorded as a maintenance write. Katrina, Rhoxie and
--    Katie appeared as Maintenance users without ever opening it, and Arturo
--    had eleven. 'system' is added to the event check so those rows can be
--    marked and left out of counts instead of deleted and argued about later.
--
-- 2. 'write' on its own does not say what somebody did. The action column
--    holds a phrase chosen in lib/activity-actions.js — never built from user
--    input, which is the same rule as 073: this table records WHICH kind of
--    thing was touched and WHICH ONE, never what it said.
--
-- Property name is explicitly allowed. It is a business fact, it is on the
-- sign outside, and without it "Updated CRM property" cannot be acted on.
-- Resident names, notes, amounts and free text remain forbidden.

alter table activity_log drop constraint if exists activity_log_event_chk;
alter table activity_log add constraint activity_log_event_chk
  check (event in ('login', 'logout', 'view', 'write', 'system', 'export', 'open'));

alter table activity_log add column if not exists action        text;
alter table activity_log add column if not exists entity_type   text;
alter table activity_log add column if not exists entity_id     text;
alter table activity_log add column if not exists property_name text;

create index if not exists activity_log_action_idx on activity_log (action, at desc);
create index if not exists activity_log_event_at_idx on activity_log (event, at desc);

-- 'open' rows are de-duplicated the same way views are: opening the same
-- record six times in half an hour is one row. Same shape as the view index
-- from 073, keyed on the record rather than the section.
create unique index if not exists activity_log_open_uniq
  on activity_log (user_email, entity_type, entity_id, view_bucket)
  where event = 'open';

-- ── Cleaning up the rows already written ────────────────────────────────────
--
-- READ THIS BEFORE RUNNING IT. The autosave and a real Command Center save go
-- to the SAME route, so they cannot be told apart after the fact: the table
-- stores section and resource, not the path. Erick ticking boxes produced rows
-- that look exactly like the boot-time noise.
--
-- What makes the delete safe in practice is who it touches. Every one of these
-- rows is from the first day of phase 1, and the only person who uses the
-- Command Center is Erick. The statement below therefore EXCLUDES him, so
-- whatever genuine saves exist are kept and only the drive-by rows from people
-- who never open Maintenance are removed.
--
--   delete from activity_log
--    where event = 'write'
--      and section = 'maintenance'
--      and resource is null
--      and user_email <> 'erick@metricpropertymanagement.com';
--
-- To see what it would remove first:
--
--   select user_email, count(*), min(at), max(at)
--     from activity_log
--    where event = 'write' and section = 'maintenance' and resource is null
--    group by user_email order by 2 desc;
--
-- From now on nothing new arrives: the route is marked system in
-- lib/activity-actions.js and the logger writes event = 'system' for it.
