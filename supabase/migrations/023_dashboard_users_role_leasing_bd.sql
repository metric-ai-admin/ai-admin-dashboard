-- 023_dashboard_users_role_leasing_bd.sql
--
-- Add the 'leasing_bd' role so Katie's account can be created with it. This role
-- grants exactly the Leasing tab + BD CRM (TAB_ACCESS.leasing_bd = ['leasing',
-- 'crm'] in public/app.js) and nothing else.
--
-- Re-creates dashboard_users_role_check with the full app vocabulary plus
-- 'leasing_bd'. Recreating a CHECK validates existing rows, so it fails if any
-- dashboard_users row holds a role not listed below — confirm first:
--
--   select distinct role from dashboard_users;   -- every value must be listed
--
-- Idempotent / safe to re-run. Run in the Supabase SQL editor.

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
    'accounting',
    'leasing',
    'leasing_bd'
  ));
