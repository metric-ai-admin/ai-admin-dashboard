-- 092 — where a call's property came from.
--
-- call_grades.property_name used to have one possible origin: the grading
-- model, answering a free-text question. From 2026-10-13 it has three, and they
-- have different error modes:
--
--   'grader'          the model chose it from a closed list of eight properties
--                     plus "Not property-specific" and "Unknown".
--   'resident_match'  the call's number belongs to exactly ONE resident in the
--                     tenant directory or the delinquency report, and the
--                     property is that resident's. The model never said it.
--   'normalised'      a spelling the model produced, mapped to its canonical
--                     name by the 2026-10-13 pass.
--
-- WITHOUT THIS COLUMN the three are indistinguishable, and a reader comparing a
-- property report against a transcript would have no way to know whether the
-- property was heard on the call or inferred from a phone number. A derived
-- value that cannot be told from an observed one is how an inference becomes a
-- fact.
--
-- NULL on every existing row, which reads as "unknown origin" and is the truth
-- for rows graded before today. Nothing is backfilled by this migration.

ALTER TABLE call_grades
  ADD COLUMN IF NOT EXISTS property_source text;

COMMENT ON COLUMN call_grades.property_source IS
  'Origin of property_name: grader | resident_match | normalised. NULL = graded before the column existed.';

CREATE INDEX IF NOT EXISTS call_grades_property_source_idx
  ON call_grades (property_source);
