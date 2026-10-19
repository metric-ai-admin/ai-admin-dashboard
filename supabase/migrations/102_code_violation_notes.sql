-- 102 — notes on a code violation, with who wrote them and when.
--
-- Agreed with Jay and Rocío, 2026-10-16/19. Today a deficiency carries three
-- free-text blocks — maintenance_remarks, client_vendor_remarks,
-- progress_notes — plus updated_by/updated_at, which record only the LAST
-- edit. If Bekah writes today and Kara writes tomorrow, the second either
-- overwrites the first or is concatenated onto it with nothing saying who said
-- which part.
--
-- THE AUTHOR IS NOT IN THE SOURCE, and we are not going to invent it.
-- The SharePoint workbook (Code_Violations_Tracker.xlsx, read 2026-10-19) has
-- twenty columns and not one of them is an author. It has TWO date columns,
-- "Date last updated" and "Last Updated", and the person appears only inside
-- the prose: "cancelled 10/07/2026 3:17 PM by Erick Frey". Pulling a name out
-- of a sentence with a pattern is guessing, and a guessed author on a code
-- violation is worse than none — it puts a name against words somebody else
-- may have written.
--
-- So imported notes get author NULL and the screen says "author not recorded".
-- Notes written in the dashboard from now on carry the signed-in user. That is
-- the same rule as authored_at: absent is a value, and it is honest.

create table if not exists code_violation_notes (
  id              uuid primary key default gen_random_uuid(),

  -- The deficiency this is about. Not a foreign key: imports arrive before the
  -- deficiency row exists on a first load, and a note whose deficiency was
  -- later renumbered is still the note somebody wrote.
  deficiency_key  text,

  -- Carried because some notes are about the CASE, not one deficiency — the
  -- workbook's Summary sheet keeps per-case notes with no deficiency at all.
  case_number     text,

  body            text not null,

  -- NULL means "we do not know", NOT "nobody". Imported rows are null; rows
  -- written in the dashboard carry the signed-in user.
  author          text,

  -- When it was WRITTEN, if the source says. NULL when it does not — never
  -- backfilled from the import time, which is a different fact.
  authored_at     timestamptz,

  source          text not null default 'dashboard',   -- 'excel' | 'dashboard'

  -- Which sheet and row it came from, so re-importing the same workbook
  -- updates instead of duplicating. The whole reason an import can be run
  -- twice without fear.
  source_row      text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- One note per source row. A second import of the same workbook replaces the
-- row rather than adding a copy; notes typed in the dashboard have no
-- source_row and are never touched by an import.
create unique index if not exists code_violation_notes_source_idx
  on code_violation_notes (source_row) where source_row is not null;

create index if not exists code_violation_notes_deficiency_idx
  on code_violation_notes (deficiency_key, created_at desc);
create index if not exists code_violation_notes_case_idx
  on code_violation_notes (case_number, created_at desc);

comment on table code_violation_notes is
  'Notes on a code violation. One row per note, so two people writing on the same deficiency do not overwrite each other.';
comment on column code_violation_notes.author is
  'NULL = not recorded. The source workbook has no author column; names appear only inside the prose and are NOT parsed out.';
comment on column code_violation_notes.authored_at is
  'When the note was written, if the source says so. NULL otherwise — never the import time, which is a different fact.';
comment on column code_violation_notes.source_row is
  'Sheet and row the note was imported from. Makes a re-import idempotent. NULL for notes written in the dashboard.';

-- The old columns are NOT dropped. They stay until the parallel run agrees,
-- so that a bad import can be compared against the original rather than
-- having destroyed it.

-- Verify:
--   select source, count(*), count(author) as with_author,
--          count(authored_at) as with_date
--     from code_violation_notes group by 1;
