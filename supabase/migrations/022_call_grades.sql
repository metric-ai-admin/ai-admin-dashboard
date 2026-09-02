-- 022_call_grades.sql
--
-- Call Quality grades. Each row is one AI grading of a call transcript against
-- Metric's rubric (Lyndsay's Call Quality Analyzer), produced server-side and
-- shown in the Call Analyzer tab. One grade per call is kept — re-grading a
-- recording replaces the prior row (the route deletes then inserts).
--
-- Idempotent; the Supabase SQL editor ignores BEGIN/COMMIT, so each statement
-- guards itself. Run in the Supabase SQL editor.

create table if not exists call_grades (
  id                uuid primary key default gen_random_uuid(),
  recording_id      text not null,
  agent_name        text,
  call_date         date,
  call_direction    text,
  duration_seconds  integer,
  property_name     text,
  overall_score     integer,
  overall_grade     text,
  legal_violation   boolean default false,
  fair_housing_flag boolean default false,
  liability_flag    boolean default false,
  summary           text,
  outcome           text,
  flags             jsonb,
  categories        jsonb,
  coaching          jsonb,
  key_moments       jsonb,
  graded_by         text default 'AI',
  graded_at         timestamptz default now(),
  created_at        timestamptz default now()
);

create index if not exists call_grades_agent_idx on call_grades (agent_name);
create index if not exists call_grades_date_idx  on call_grades (call_date);
create index if not exists call_grades_grade_idx on call_grades (overall_grade);
