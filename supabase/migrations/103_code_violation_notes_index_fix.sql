-- 103 — replace the partial unique index on code_violation_notes.source_row
-- with a plain one, so the import can actually upsert on it.
--
-- MY MISTAKE, 2026-10-19. Migration 102 created:
--
--   create unique index ... on code_violation_notes (source_row)
--     where source_row is not null;
--
-- reasoning that dashboard notes have a NULL source_row and should not
-- collide with each other. That reasoning was unnecessary and the index it
-- produced is unusable: Postgres will only use a PARTIAL index for ON CONFLICT
-- if the statement repeats the same WHERE clause, and PostgREST's
-- `onConflict=source_row` cannot express one. The import wrote all 78
-- deficiencies and then failed on the notes with
--
--   there is no unique or exclusion constraint matching the ON CONFLICT specification
--
-- leaving 78 deficiencies stored and 0 notes.
--
-- A PLAIN UNIQUE INDEX ALREADY DOES WHAT THE PARTIAL ONE WAS FOR. In Postgres
-- NULLs are never equal to each other, so a plain unique index on source_row
-- permits any number of dashboard notes (all NULL) while still allowing only
-- one row per imported cell. The partial clause bought nothing and cost the
-- upsert.

drop index if exists code_violation_notes_source_idx;

create unique index if not exists code_violation_notes_source_idx
  on code_violation_notes (source_row);

comment on index code_violation_notes_source_idx is
  'One row per imported workbook cell. NULLs do not collide in Postgres, so dashboard notes (source_row NULL) are unaffected and unlimited.';

-- Verify — both should be possible:
--   two dashboard notes:
--     insert into code_violation_notes (body, author) values ('a','x'), ('b','x');
--   a second import of the same cell replaces rather than duplicates:
--     select source_row, count(*) from code_violation_notes
--      where source_row is not null group by 1 having count(*) > 1;   -- empty
