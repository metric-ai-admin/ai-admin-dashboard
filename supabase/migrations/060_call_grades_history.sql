-- 060_call_grades_history.sql
--
-- Grade history. call_grades keeps exactly ONE row per recording_id (unique
-- index, migration 051), so every regrade destroys the grade it replaces. Until
-- now the only way back was a JSON file in exports/ — which is gitignored,
-- lives on a Render disk, and is gone the moment that instance is recycled.
-- Lyndsay needs "what did this call score before the v2.1 rubric" to be a
-- question the database can answer, not one that depends on a file surviving.
--
-- Each row here is the FULL prior state of a call_grades row, captured just
-- before it was overwritten. The snapshot is jsonb rather than mirrored columns
-- on purpose: call_grades has gained columns five times (042, 053, 055 ...) and
-- a mirrored table drifts silently, losing exactly the fields nobody thought to
-- add. jsonb cannot drift.
--
-- Idempotent and safe to re-run. Run in the Supabase SQL editor.

create table if not exists call_grades_history (
  id             uuid primary key default gen_random_uuid(),

  -- Stable across regrades; call_grades.id is not (the route deletes/inserts).
  recording_id   text not null,

  -- The complete call_grades row as it stood BEFORE the overwrite.
  previous       jsonb not null,

  -- Denormalised out of `previous` so the common questions — what did this
  -- score before, which rubric produced it — are answerable without digging
  -- into jsonb. Redundant by design; `previous` remains the source of truth.
  previous_score integer,
  previous_grade text,
  previous_graded_by text,
  previous_graded_at timestamptz,

  -- One id per regrade run, so a whole batch can be found, audited, or undone
  -- as a unit. Without it, two runs on the same day are indistinguishable.
  batch_id       text not null,
  -- What replaced it, e.g. 'AI (rubric v2.1 regrade)'.
  replaced_by    text,
  replaced_at    timestamptz not null default now(),
  -- Who or what ran it: a script name, or a username for a UI-triggered regrade.
  source         text
);

-- "Show me this call's grade history" — the main read.
create index if not exists call_grades_history_recording_idx
  on call_grades_history (recording_id, replaced_at desc);

-- "Show me / undo that run."
create index if not exists call_grades_history_batch_idx
  on call_grades_history (batch_id);

create index if not exists call_grades_history_at_idx
  on call_grades_history (replaced_at desc);

-- Deliberately NO unique constraint on recording_id: the whole point is that a
-- call accumulates one row per regrade. Deliberately no foreign key to
-- call_grades either — history has to outlive the row it describes, and
-- call_grades rows are deleted and reinserted by the grading route.

-- Verify:
--   select count(*) from call_grades_history;
--   select recording_id, previous_score, previous_graded_by, replaced_at
--     from call_grades_history order by replaced_at desc limit 10;
