-- BD CRM — G&B Management rotation
--
-- G&B has one phone number for all of its properties, so the same person must
-- not call it twice in a row. Confirmed with Lyndsay 2026-08-31: four people
-- rotate roughly every two weeks, chosen randomly.
--
-- Run in the Supabase SQL editor. Every statement is IF NOT EXISTS and safe to
-- re-run; the editor does not honour BEGIN/COMMIT.

-- ---------------------------------------------------------------------------
-- Who is in the rotation.
--
-- The brief says to read the agents from dashboard_users where role='bd_agent'.
-- That returns three people — Katie, Katrina Marie Lopez, Rhoxie — because Lisa
-- is a contractor with no dashboard login. The rotation would have run three
-- ways instead of four and nothing would have said so.
--
-- Lisa IS in bd_agents, seeded by migration 004, but with status 'unknown':
-- we do not know whether she is still working with us, and that is a different
-- question from whether she takes G&B calls. So membership is its own flag
-- rather than a filter on employment status, and nobody's name is compiled
-- into the code.
-- ---------------------------------------------------------------------------
alter table bd_agents add column if not exists in_gb_rotation boolean not null default false;

create index if not exists bd_agents_gb_rotation_idx
  on bd_agents (in_gb_rotation) where in_gb_rotation;

-- Tick the four Lyndsay named. Matched on crm_alias where there is one and on
-- name otherwise, since that is how Lisa is stored. Re-running is harmless.
update bd_agents set in_gb_rotation = true
 where lower(btrim(coalesce(crm_alias, name))) in ('rhoxie', 'katie', 'katrina', 'lisa');

-- ---------------------------------------------------------------------------
-- The rotation itself. One row per property per assignment, kept rather than
-- overwritten: "the same person must not call twice in a row" is a question
-- about history, and an UPDATE-in-place table cannot answer it.
-- ---------------------------------------------------------------------------
create table if not exists gb_rotation (
  id             uuid primary key default gen_random_uuid(),
  property_id    uuid not null references properties(id) on delete cascade,
  assigned_agent text not null,
  assigned_at    timestamptz not null default now(),
  -- Two weeks, as agreed. Stored rather than computed on read so changing the
  -- interval later cannot silently rewrite when past assignments were due.
  rotate_after   date not null default (current_date + 14),
  notes          text
);

-- Every read is "the current assignment for this property" or "this property's
-- history, newest first".
create index if not exists gb_rotation_property_idx
  on gb_rotation (property_id, assigned_at desc);

-- Drives the overdue badge.
create index if not exists gb_rotation_rotate_after_idx
  on gb_rotation (rotate_after);

-- Check — current assignment per property:
-- select distinct on (property_id) property_id, assigned_agent, assigned_at, rotate_after
-- from gb_rotation order by property_id, assigned_at desc;
--
-- Check — who is in the rotation:
-- select name, crm_alias, status, in_gb_rotation from bd_agents where in_gb_rotation;
