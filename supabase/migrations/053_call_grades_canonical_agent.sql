-- 053_call_grades_canonical_agent.sql
--
-- One agent, one name. call_grades held the same two people under four names:
--
--     Rocío  45      Rocio  36       -> both are Rocío Hunsberger
--     Sammy  10      Sammy Ramos  4  -> both are Sammy Ramos
--
-- Every per-agent figure the Call Analyzer shows — averages, the leaderboard,
-- the not-scoreable rate — was computed per NAME, so those two were each split
-- across two rows and both halves were wrong.
--
-- Three things produced the duplicate spellings:
--   1. the SimpleVOIP roster suffix — "Danny Metric" vs "Danny"
--   2. the accent — the line owner arrives as "Rocio", self-identification
--      from the transcript as "Rocío"
--   3. first name vs full name — "Sammy" from the transcript, "Sammy Ramos"
--      from the roster
--
-- normalizeAgentName() only ever handled (1). It now delegates to
-- canonicalAgentName() in call-grading.js, which handles all three, so new rows
-- land canonical. This migration repairs the rows written before that.
--
-- Targets are the spelling already dominant in the table, which keeps the
-- update to 46 rows. Idempotent: re-running matches nothing the second time.
-- Run in the Supabase SQL editor.

-- Check first — this should list exactly the pairs above:
--   select agent_name, count(*) from call_grades group by 1 order by 2 desc;

update call_grades set agent_name = 'Rocío'       where agent_name = 'Rocio';
update call_grades set agent_name = 'Sammy Ramos' where agent_name = 'Sammy';

-- The 6 rows marked not_scoreable with reason 'malformed_response' were calls
-- whose grading response was cut off at max_tokens, not calls that cannot be
-- scored. anthropicJson() now retries once at double the cap, so these can
-- succeed. Deleting the rows is what re-queues them: autoGradeDay() skips a call
-- only when a call_grades row already exists, so with the row gone the next
-- backfill or the 2 AM cron grades them again.
delete from call_grades where not_scoreable_reason = 'malformed_response';

-- Check after:
--   select agent_name, count(*) from call_grades group by 1 order by 2 desc;
--   -- expect Rocío 81, Sammy Ramos 14, and no 'Rocio' or bare 'Sammy' rows
--   select count(*) from call_grades where not_scoreable_reason = 'malformed_response';
--   -- expect 0, rising again only if a transcript truncates even at 16000 tokens
