-- 020_leasing_submissions.sql
--
-- Weekly Leasing Goal Board — online migration.
--
-- Katie fills out the leasing goal board every week (occupancy targets, leasing
-- goals per property, narrative commentary) and submits it to Lyndsay, Kara and
-- Bekah. It used to live only as a local Claude artifact with no persistence;
-- this table is where each week's submission is stored and reviewed.
--
-- Idempotent: safe to re-run. The Supabase SQL editor does not honour
-- BEGIN/COMMIT, so every statement guards itself with IF [NOT] EXISTS.
-- Run in the Supabase SQL editor.

create table if not exists leasing_submissions (
  id            uuid primary key default gen_random_uuid(),
  week_ending   date not null,                       -- the week this report covers (a Sunday)
  submitted_by  text default 'Katie',
  submitted_at  timestamptz default now(),
  status        text default 'submitted',            -- 'submitted' | 'reviewed' | 'approved'
  narrative     text,                                -- Katie's weekly commentary
  goals_json    jsonb,                               -- goal slider values (occupancy targets, etc.)
  data_json     jsonb,                               -- full leasing data snapshot imported from Excel
  kpi_json      jsonb,                               -- computed KPI snapshot at time of submission
  notes         text,                                -- reviewer notes from Lyndsay/Kara/Bekah
  created_at    timestamptz default now()
);

-- One submission per week — a re-submit for the same week upserts on this key.
create unique index if not exists leasing_submissions_week_key
  on leasing_submissions (week_ending);

-- Status must be one of the three known states. Guarded so a re-run is a no-op.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'leasing_submissions'::regclass
      and conname  = 'leasing_submissions_status_check'
  ) then
    alter table leasing_submissions
      add constraint leasing_submissions_status_check
      check (status in ('submitted', 'reviewed', 'approved'));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Access: add the 'leasing' role so Katie's account (katie@metric.internal) can
-- be created with role = 'leasing'. This re-creates dashboard_users_role_check
-- with the full app vocabulary (from TAB_ACCESS in public/app.js) plus 'leasing'.
-- Recreating a CHECK validates existing rows, so it fails if any dashboard_users
-- row holds a role not listed below — confirm the list matches production first:
--
--   select distinct role from dashboard_users;   -- every value must be listed
--
-- Already-applied-by-hand in production is a safe no-op re-sync.
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
    'leasing'
  ));
