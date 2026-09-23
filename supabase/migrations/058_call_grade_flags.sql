-- Flag for Policy Review — Lyndsay marking grading errors she wants fixed.
--
-- A separate table rather than columns on call_grades, for one reason: a flag is
-- a statement ABOUT a grade, not part of it. Regrading a call replaces the
-- call_grades row; the flag that said "this grading is wrong" has to survive
-- that, otherwise the record of the complaint disappears the moment someone
-- acts on it. Keyed on recording_id, which is stable across regrades — the
-- call_grades.id is not.
--
-- Run in the Supabase SQL editor. IF NOT EXISTS throughout and safe to re-run.

create table if not exists call_grade_flags (
  id           uuid primary key default gen_random_uuid(),
  -- One live flag per call. Re-flagging updates the note rather than stacking
  -- duplicates, which is what the UI's toggle expects.
  recording_id text not null unique,
  flagged_by   text not null,
  flagged_at   timestamptz not null default now(),
  flag_note    text,

  -- Set when the grading issue has been dealt with. Kept rather than deleted so
  -- "what did we already fix" is answerable later; the UI filters on it.
  resolved     boolean not null default false,
  resolved_by  text,
  resolved_at  timestamptz,

  updated_at   timestamptz not null default now()
);

create index if not exists call_grade_flags_resolved_idx on call_grade_flags (resolved);
create index if not exists call_grade_flags_at_idx on call_grade_flags (flagged_at desc);
