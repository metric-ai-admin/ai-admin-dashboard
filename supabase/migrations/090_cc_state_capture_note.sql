-- 090 — mark a Command Center snapshot that was taken before its own day began.
--
-- The 2026-10-03 row was generated at 2026-10-03T01:03Z, which is 2026-10-02
-- 20:03 CT: three hours before Friday started. Its 243 tasks are Thursday's.
-- Every other row that week was written between 16:30 and 17:30 CT on its own
-- day.
--
-- WHY A COLUMN AND NOT A DELETE. The row is evidence of what the nightly job
-- did. Deleting it would leave the day indistinguishable from one where the
-- job never ran, which is a different fact and a less useful one. The history
-- reads this note and answers "no record (captured late)".
--
-- lib/daily-report-history.js derives the same verdict from generated_at when
-- this column is empty, so the rule holds for the next occurrence whether or
-- not anybody remembers to fill it in. The column is the record of a decision
-- a human made about one row; the derived rule is the safety net.

ALTER TABLE cc_daily_state
  ADD COLUMN IF NOT EXISTS capture_note text;

COMMENT ON COLUMN cc_daily_state.capture_note IS
  'Set when the snapshot does not describe the day it is filed under. The Daily Report history shows this text instead of the figures. Written by scripts/mark-cc-late-capture.js.';
