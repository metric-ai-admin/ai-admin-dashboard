-- 112 — the grants the last ten migrations did not write down.
--
-- Supabase announced that from 2026-10-30 a NEW table in `public` needs an
-- explicit GRANT in the same migration or the Data API answers "permission
-- denied". Existing tables keep whatever they were given automatically.
--
-- THESE EIGHT WORK TODAY and that is exactly the problem: they work because a
-- default handed them a permission nobody wrote down. Rebuild this schema from
-- the migration files — a new environment, a restore, a staging copy — and
-- every one of them comes up unreadable, with no file in the repo saying what
-- it should have had. A permission that exists only in the live database is
-- not in version control.
--
--   102  code_violation_notes
--   105  code_violation_closed_cases
--   106  code_violation_watchlist_history
--   107  code_violation_work_orders
--   108  social_posts, social_post_roster
--   111  deposit_held, deposit_sync_runs
--
-- THESE EIGHT ARE NOT THE WHOLE PROBLEM. The test written alongside this file
-- reported 78 tables across the full history: no migration in this repo has
-- ever written a grant, from 001_bd_crm onward. These eight are backfilled
-- because they are the newest and the ones a rebuild would miss first; the
-- other seventy are a known gap, not a solved one, and whether to backfill
-- them is a decision rather than a cleanup. Four of them also have ungranted
-- sequences: leasing_occupancy_history, activity_log, unit_vacancy_history
-- and work_order_reconcile_log.
--
-- SERVICE_ROLE ONLY, and that is not a shortcut. Nothing in public/ talks to
-- Supabase: every read and write goes through an Express route holding the
-- service-role key, so `authenticated` would grant access to a client that
-- does not exist and `anon` would open these to the internet. The two that
-- carry resident-adjacent data — social_posts (who posted what) and
-- deposit_held (a resident's deposit and move-out) — are the ones where that
-- matters most.
--
-- Idempotent. GRANT is additive and re-running changes nothing.

grant all privileges on table code_violation_notes             to service_role;
grant all privileges on table code_violation_closed_cases      to service_role;
grant all privileges on table code_violation_watchlist_history to service_role;
grant all privileges on table code_violation_work_orders       to service_role;
grant all privileges on table social_posts                     to service_role;
grant all privileges on table social_post_roster               to service_role;
grant all privileges on table deposit_held                     to service_role;
grant all privileges on table deposit_sync_runs                to service_role;

-- deposit_sync_runs.id is bigserial, which is a sequence, and a grant on the
-- table does not reach it: an insert would fail on nextval() with the table
-- itself perfectly readable. The other seven use uuid defaults and need none.
grant usage, select on sequence deposit_sync_runs_id_seq to service_role;

-- Verify:
--   select table_name, grantee, privilege_type
--     from information_schema.role_table_grants
--    where grantee = 'service_role'
--      and table_name in ('code_violation_notes','code_violation_closed_cases',
--                         'code_violation_watchlist_history','code_violation_work_orders',
--                         'social_posts','social_post_roster',
--                         'deposit_held','deposit_sync_runs')
--    order by table_name, privilege_type;
--
--   -- and the sequence:
--   select sequence_name from information_schema.sequences
--    where sequence_name = 'deposit_sync_runs_id_seq';
