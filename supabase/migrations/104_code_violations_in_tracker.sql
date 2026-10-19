-- 104 — mark the deficiencies the current SharePoint tracker does not contain.
--
-- Arturo, 2026-10-19: "las que no coincidan con ninguna hoja, márcalas como
-- 'no está en el tracker actual' (sin borrarlas) para que no envejezcan en
-- silencio."
--
-- After the 2026-10-19 import there are 129 rows: 78 from the workbook and 51
-- from before it. The 51 are not closed cases that moved — the Closed Cases
-- sheet has eight rows and a different shape — they are 50 rows written by
-- scripts/seed-code-violations.js plus one Arturo edited by hand.
--
-- WHAT THEY ARE IS NOT SETTLED, and the flag is deliberately not a judgement.
-- 39 of them share a case number AND a work order with a row we just
-- imported, but not one shares the opening description. That is either the
-- same deficiency reworded or a genuinely different deficiency under the same
-- case and work order — a single work order routinely covers several. Only
-- somebody reading both can say which, so this records the fact (the current
-- tracker does not contain it) and not the conclusion (it is a duplicate).
--
-- Same shape as leasing_lease_history.in_feed: a row that stops appearing in
-- its source keeps its values and stops passing for current.

alter table code_violations
  add column if not exists in_current_tracker boolean;

alter table code_violations
  add column if not exists tracker_checked_at timestamptz;

comment on column code_violations.in_current_tracker is
  'TRUE when the last SharePoint import found this deficiency in the workbook. FALSE when it did not. NULL = never checked. Not a judgement about whether the row is right.';
comment on column code_violations.tracker_checked_at is
  'When an import last looked for this row in the workbook.';

create index if not exists code_violations_in_tracker_idx
  on code_violations (in_current_tracker, property_name);

-- Verify:
--   select in_current_tracker, count(*) from code_violations group by 1;
--   select property_name, case_number, work_order, status
--     from code_violations where in_current_tracker is false
--     order by property_name, case_number;
