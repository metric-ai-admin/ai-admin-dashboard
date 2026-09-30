-- 071_marketing_note_and_role.sql
--
-- Two things migration 070 needed and did not have. Run BOTH before the
-- marketing directory is seeded and before Katrina's role is changed.
--
-- Idempotent and safe to re-run.

-- ── 1. The note column ──────────────────────────────────────────────────────
--
-- 070 was run from the version of the SQL that predates it. The column carries
-- what a row disagrees about, shown under the property name in the UI.
--
-- Ascent at Northgate is why it exists: its own site links a Google listing for
-- 1830 W Rundberg Ln, while AppFolio and the bank both have the property at
-- 9315 Northgate Blvd. The link is stored unverified and the disagreement is
-- written down rather than resolved by guessing which source is right.
alter table property_marketing add column if not exists note text;

-- ── 2. The new role ─────────────────────────────────────────────────────────
--
-- dashboard_users.role carries a CHECK constraint, so a role the code knows
-- about cannot be assigned until the constraint knows about it too — the
-- update fails with dashboard_users_role_check.
--
-- marketing_bd_agent is Katrina: the BD CRM she already has, plus the marketing
-- directory. A NEW role rather than widening bd_agent, because Rhoxie is a
-- bd_agent as well and the directory is not hers to edit.
--
-- The list below is every role currently in use plus every role TAB_ACCESS
-- defines; the two sets were compared on 2026-09-30 and nothing in use was
-- missing from the code. Dropping first and re-adding keeps this re-runnable.
alter table dashboard_users drop constraint if exists dashboard_users_role_check;
alter table dashboard_users add constraint dashboard_users_role_check
  check (role in (
    'accounting',
    'admin',
    'bd_agent',
    'ceo',
    'collections_agent',
    'collections_leasing',
    'evictions_agent',
    'leasing',
    'leasing_bd',
    'maintenance',
    'marketing_bd_agent',
    'operations',
    'regional_director',
    'resident_success'
  ));

-- Verify:
--
--   select column_name from information_schema.columns
--    where table_name = 'property_marketing' and column_name = 'note';
--
--   update dashboard_users set role = 'marketing_bd_agent'
--    where email = 'katrina@metric.internal';
--   select name, email, role from dashboard_users order by role;
--
-- Katie is leasing_bd, not bd_agent — worth knowing before assuming a change
-- to bd_agent would or would not have reached her. Neither role grants
-- 'marketing', so she does not see the tab either way.
