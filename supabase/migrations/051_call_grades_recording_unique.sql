-- 051_call_grades_recording_unique.sql
--
-- One grade per recording. The code has always enforced this in application
-- logic (autoGradeDay and autoGradeCall both SELECT first, and the save is a
-- delete-then-insert), but there was no database constraint, so two concurrent
-- passes — the nightly cron and a manual backfill overlapping — could both pass
-- the existence check and insert duplicate rows for the same call.
--
-- With this index in place that race ends as a 23505 unique violation, which
-- autoGradeCall treats as 'already graded' rather than an error.
--
-- NOTE: duplicates must be cleared before the index will build. The delete below
-- keeps the most recently graded row per recording_id and drops the rest; run it
-- first and check the count, then create the index.
--
-- Idempotent. Run in the Supabase SQL editor.

-- Inspect first — how many duplicate rows exist:
--   select recording_id, count(*) from call_grades
--   group by recording_id having count(*) > 1 order by 2 desc;

delete from call_grades a
using call_grades b
where a.recording_id = b.recording_id
  and a.id <> b.id
  and (a.graded_at, a.id) < (b.graded_at, b.id);

create unique index if not exists call_grades_recording_key
  on call_grades (recording_id);
