-- 042_call_grades_not_scoreable.sql
--
-- Vendor/utility/internal calls (AppFolio support, City of Austin Utilities,
-- Chariot Energy, IVR trees, …) and calls where the speaking agent isn't the one
-- the call is attributed to should NOT be scored against the leasing rubric. The
-- grading prompt now returns not_scoreable:true for them; those rows are stored
-- with overall_grade 'N/S' and no score so they never drag the averages.
--
-- Idempotent. Run in the Supabase SQL editor.

alter table call_grades add column if not exists not_scoreable        boolean default false;
alter table call_grades add column if not exists not_scoreable_reason text;

create index if not exists call_grades_ns_idx on call_grades (not_scoreable);
