-- 105 — closed code-violation cases, as cases.
--
-- Arturo, 2026-10-19: import the Closed Cases sheet as CASES, not as synthetic
-- deficiencies. The sheet is case-level — six real rows, each one a case
-- somebody closed — and manufacturing a deficiency row per case would put
-- fabricated citations in the tracker to make a count work.
--
-- THE SHEET HAS NO CASE NUMBER COLUMN. Its six columns are Property, Items,
-- Status, Resolution, Closed and Closed by. A City case number (2025-036688
-- CV) is a strict, unambiguous token, so the import lifts one out of the
-- Status/Resolution text when it is there and leaves case_number NULL when it
-- is not — and reports how many of each. That is different from reading an
-- AUTHOR out of prose, which this codebase refuses to do: a case number is a
-- fact with one possible reading, a name in a sentence is an attribution with
-- several.
--
-- `items` is an integer. Every filled row has one, and they sum to the total
-- row the sheet carries. An empty cell is NULL, not 0 — "we were not told how
-- many" and "none" are different.

create table if not exists code_violation_closed_cases (
  id            uuid primary key default gen_random_uuid(),

  -- NULL when the sheet does not carry one. Not invented.
  case_number   text,
  property      text not null,

  -- How many deficiencies the case covered, per the sheet. NULL = not stated.
  items         integer,

  status        text,
  resolution    text,
  closed_at     date,
  closed_by     text,

  source        text not null default 'excel',
  -- Sheet and row, so re-importing replaces rather than duplicating. The only
  -- identity these rows have: with no case number on six of them, nothing
  -- else is unique.
  source_row    text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index if not exists code_violation_closed_cases_source_idx
  on code_violation_closed_cases (source_row);

create index if not exists code_violation_closed_cases_case_idx
  on code_violation_closed_cases (case_number);

comment on table code_violation_closed_cases is
  'Closed cases from the Closed Cases sheet. Case-level: no deficiency rows are manufactured from them.';
comment on column code_violation_closed_cases.case_number is
  'NULL when the sheet does not state one. The sheet has no case-number column; a strict CV token is lifted from the text when present and never guessed.';
comment on column code_violation_closed_cases.items is
  'Deficiencies the case covered, per the sheet. NULL = not stated, which is not the same as none.';

-- Verify:
--   select count(*), count(case_number), count(items), count(closed_at)
--     from code_violation_closed_cases;
