-- BD CRM Phase C · Module 3 — Agent Roster
--
-- Run this in the Supabase SQL editor before deploying the code that reads it.
-- Note the editor does not honour BEGIN/COMMIT the way psql does — that is what
-- cost us rows during the property dedup — so every statement here is written to
-- be safe on its own and re-runnable.

create table if not exists bd_agents (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  email      text,
  role       text not null default 'BD Agent',
  phone      text,
  -- 'unknown' is a real state here, not a placeholder: five of the seeded
  -- agents are names we have without knowing whether they are still working
  -- with us. Defaulting them to 'active' would assert something we do not know.
  status     text not null default 'active' check (status in ('active','inactive','unknown')),
  -- The CRM stores short names in properties.phone_assignee / phone_assignee3 /
  -- online_dm_assignee — literally 'Rhoxie', not 'Roxanne De Vero'. The Task
  -- Queue filter compares against those strings, so the roster has to carry the
  -- name the data actually uses or filtering by an agent returns nothing.
  crm_alias  text,
  notes      text,
  created_at timestamptz not null default now()
);

-- Dedup guards. The spec said "insert if not exists by email", but five of the
-- eight seeded agents have no email, so email alone cannot identify a row.
-- Normalised the same way the properties index is, for the same reason:
-- 'Katie', 'katie' and 'Katie ' must not become three agents.
create unique index if not exists bd_agents_name_key
  on bd_agents (lower(btrim(name)));
-- Partial, so the rows without an email do not all collide on null.
create unique index if not exists bd_agents_email_key
  on bd_agents (lower(btrim(email))) where email is not null;

create index if not exists bd_agents_status_idx on bd_agents (status);

-- Seed. ON CONFLICT DO NOTHING against the name index, so re-running is a no-op
-- rather than a second roster.
insert into bd_agents (name, email, role, status, crm_alias) values
  ('Roxanne De Vero', 'rhoxie@livewithmetric.com',  'BD Agent', 'active',  'Rhoxie'),
  ('Katie',           'katie@livewithmetric.com',   'BD Agent', 'active',  'Katie'),
  ('Katrina Lopez',   'katrina@livewithmetric.com', 'BD Agent', 'active',  'Katrina'),
  ('Oscar',            null,                        'BD Agent', 'unknown', null),
  ('Ken',              null,                        'BD Agent', 'unknown', null),
  ('Lisa',             null,                        'BD Agent', 'unknown', null),
  ('Hanna',            null,                        'BD Agent', 'unknown', null),
  ('Bekah''s Friend',  null,                        'BD Agent', 'unknown', null)
on conflict do nothing;

-- Not in the requested list, but both already appear in the dropdowns this
-- module replaces. Lyndsay in particular is who crm-task-engine.js assigns every
-- owner_response task to, so dropping her from the filter would hide the
-- highest-priority queue in the CRM. Delete these two rows if that is not
-- wanted — nothing else depends on them.
insert into bd_agents (name, email, role, status, crm_alias) values
  ('Lyndsay Hanes', 'lyndsay@livewithmetric.com', 'CEO',                    'active', 'Lyndsay'),
  ('Erick Frey',    null,                         'Maintenance Coordinator','active', 'Erick')
on conflict do nothing;

-- Check: expect 10 rows, 5 active, 5 unknown, 0 inactive.
-- select status, count(*) from bd_agents group by status order by status;
