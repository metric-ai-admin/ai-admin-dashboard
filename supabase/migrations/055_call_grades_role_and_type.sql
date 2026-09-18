-- 055_call_grades_role_and_type.sql
--
-- Three fields rubric v2.0 produces that had nowhere to go.
--
-- The v2.0 prompt (Lyndsay, 2026-09-18) is role-aware and call-type-aware: Step 1
-- maps the agent to a role, Step 2 classifies the call, and Step 5 picks one of
-- nine rubrics from those two. Its Step 10 output reports all three, and without
-- these columns that reasoning was discarded on write — leaving no way to check
-- whether a call was graded against the right rubric, which is the single thing
-- v2.0 exists to fix ("Applying the wrong rubric is worse than applying no
-- rubric at all").
--
--   agent_role      Step 1, e.g. 'Receptionist', 'Leasing Agent',
--                   'Collections Specialist', 'Maintenance Coordinator'
--   call_type       Step 2, e.g. 'LEASING', 'TRANSFER-ROUTING', 'MAINTENANCE'
--   rubric_applied  Step 5, e.g. 'A — Receptionist', 'I — Transfer/Routing'
--
-- All three are free text on purpose. They are the model's classification, not a
-- controlled vocabulary we enforce, and a CHECK constraint would turn a wording
-- drift into a failed insert that loses the whole grade.
--
-- The server tolerates these columns being absent: saveCallGrade() retries
-- without them and logs a warning, so a deploy landing before this migration
-- grades correctly and only loses the three fields. Run this and the warning
-- stops.
--
-- Idempotent. Run in the Supabase SQL editor.

alter table call_grades add column if not exists agent_role     text;
alter table call_grades add column if not exists call_type      text;
alter table call_grades add column if not exists rubric_applied text;

-- Lyndsay reviews the export grouped by call type, and the Call Analyzer will
-- filter on it.
create index if not exists call_grades_call_type_idx on call_grades (call_type);
create index if not exists call_grades_agent_role_idx on call_grades (agent_role);

-- Check — after a re-grade this shows which rubric each call type landed on,
-- which is how a mis-routed rubric becomes visible:
--   select call_type, rubric_applied, count(*)
--   from call_grades where not_scoreable is not true
--   group by 1, 2 order by 3 desc;
