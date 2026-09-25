-- 061_code_violations_import_conflict.sql
--
-- Stop the importer silently overwriting a status a person set by hand.
--
-- WHAT HAPPENS TODAY. /api/code-violations/import upserts on deficiency_key
-- with the whole row, `status` included. Re-running the workbook import — or
-- scripts/seed-code-violations.js — replaces every manual status with whatever
-- the spreadsheet says, and stamps updated_by with the importer's name. Bekah's
-- change disappears with no record that it ever existed. Jay reported this as
-- the Refresh button re-syncing from AppFolio; Refresh is a GET and nothing
-- syncs this table from AppFolio at all, but the overwrite itself is real and
-- import is the trigger.
--
-- WHY NEW COLUMNS RATHER THAN A CHECK ON updated_by. The obvious test — "was
-- this row touched by a person rather than an importer" — cannot be asked of
-- the current schema. updated_by is actorName(req) on BOTH paths: the PATCH
-- route writes the editor's name and the import route writes the admin's name,
-- and both are just a person's name. There is nothing to compare. So the manual
-- act is recorded explicitly, by the only route a human status change can come
-- through.
--
-- Idempotent and safe to re-run. Run in the Supabase SQL editor.

-- ── Who set the status by hand, and when ───────────────────────────────────
-- Written ONLY by PATCH /api/code-violations/:key, and never by an importer.
-- Its presence is what marks a row as manually held; its absence means the
-- import may overwrite freely, which is the right default for the 67 rows that
-- came out of the workbook and have never been touched since.
alter table code_violations add column if not exists status_set_by text;
alter table code_violations add column if not exists status_set_at timestamptz;

-- ── The incoming value, parked rather than applied ─────────────────────────
-- When an import disagrees with a manually-held status, the spreadsheet's value
-- lands here instead of in `status`. The row keeps working with the status the
-- person chose, and the disagreement is visible instead of resolved by whoever
-- happened to run the import last.
--
-- NOT a queue: a second import overwrites this with its own value. What is
-- being preserved is the human's status, not a history of every spreadsheet
-- that disagreed with it.
alter table code_violations add column if not exists pending_import_status text;
alter table code_violations add column if not exists pending_import_at     timestamptz;
-- 'excel' | 'appfolio' | 'seed' — which import proposed it, so "where did this
-- come from" is answerable without reading the server log.
alter table code_violations add column if not exists pending_import_source text;

-- Finding the rows that need a decision is the main read this adds.
create index if not exists code_violations_pending_import_idx
  on code_violations (pending_import_status)
  where pending_import_status is not null;

-- ── Backfill ───────────────────────────────────────────────────────────────
-- Rows closed with Code Compliance were definitely set by a person: the route
-- has always required Jay or Bekah for that status and records who and when.
-- Marking them manually-held means the next import cannot quietly reopen a
-- case that was closed with the city, which is the worst version of this bug.
--
-- Everything else is left null on purpose. A row nobody has touched should be
-- freely updatable by the workbook, and guessing that other rows were manual
-- would lock the import out of data it is supposed to maintain.
update code_violations
   set status_set_by = closed_by,
       status_set_at = closed_at
 where status = 'Closed by Code Compliance'
   and closed_by is not null
   and status_set_at is null;

-- Verify:
--   select count(*) from code_violations where status_set_at is not null;
--   select count(*) from code_violations where pending_import_status is not null;
--   select deficiency_key, status, pending_import_status, status_set_by, status_set_at
--     from code_violations where pending_import_status is not null;
