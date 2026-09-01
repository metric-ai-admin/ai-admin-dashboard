-- dashboard_users role constraint — add 'accounting'
--
-- Context: dashboard_users (and its dashboard_users_role_check constraint) were
-- created ad-hoc in Supabase and never captured in a migration file — 010/011
-- only reference the table, they do not define it. Production's constraint was
-- updated by hand to allow 'accounting' (Claudia). This migration brings the
-- repo in sync so the allowed-role list lives in version control.
--
-- The role list below is the app's complete vocabulary, taken from TAB_ACCESS
-- in public/app.js. Recreating a CHECK validates existing rows, so it fails if
-- any dashboard_users row already holds a role NOT in this list. Before running,
-- confirm the list matches production:
--
--   select conname, pg_get_constraintdef(oid)
--   from pg_constraint
--   where conrelid = 'dashboard_users'::regclass and contype = 'c';
--
--   select distinct role from dashboard_users;   -- every value must be listed below
--
-- Already applied by hand in production, so running this there is a safe no-op
-- re-sync. Run in the Supabase SQL editor.

alter table dashboard_users drop constraint if exists dashboard_users_role_check;

alter table dashboard_users add constraint dashboard_users_role_check
  check (role in (
    'admin',
    'ceo',
    'operations',
    'maintenance',
    'bd_agent',
    'regional_director',
    'resident_success',
    'collections_leasing',
    'accounting'
  ));
