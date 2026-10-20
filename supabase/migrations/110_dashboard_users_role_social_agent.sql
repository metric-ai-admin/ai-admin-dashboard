-- 110 — the 'social_agent' role.
--
-- Sammy, Oscar, Yeni and Daria upload their post links and see nothing else:
-- one tab ('socialposts') and their own history. A NEW role rather than
-- widening 'leasing' or 'marketing_bd_agent' — 'leasing' is Katie's and opens
-- the Leasing tab and the BD CRM, 'marketing_bd_agent' is Katrina's and opens
-- the property marketing directory. Neither is theirs to see.
--
-- Rocío keeps collections_leasing. She is on the roster and the form is open
-- to every signed-in user, so she needs no role change to upload; giving her
-- social_agent would TAKE the Collections tab away.
--
-- dashboard_users.role carries a CHECK constraint, so the role has to exist
-- here before any account can be created with it — the insert fails with
-- dashboard_users_role_check otherwise. RUN THIS BEFORE creating the four
-- accounts.
--
-- The list below is every role in use in production on 2026-10-20 (checked
-- against `select distinct role from dashboard_users`) plus every role
-- TAB_ACCESS defines. Recreating a CHECK validates existing rows, so it fails
-- if any row holds a role not listed. Confirm first:
--
--   select distinct role from dashboard_users;   -- every value must be listed
--
-- Idempotent / safe to re-run. Run in the Supabase SQL editor.

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
    'resident_success',
    'social_agent'
  ));

-- Verify:
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conrelid = 'dashboard_users'::regclass and contype = 'c';
--   -- then, once the accounts exist:
--   select name, email, role from dashboard_users where role = 'social_agent';
