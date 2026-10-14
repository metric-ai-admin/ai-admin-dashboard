-- 095 — the columns inspection_detail actually returns.
--
-- Probed live on 2026-10-14: the report has 14 columns and `inspection_date`
-- is NOT one of them. The sync asked for it anyway, so that column has been
-- null on all 635 rows since the sync was written — a guessed field name fails
-- exactly like a field nobody fills in, which is why nobody noticed.
--
-- What the report really returns, and what matters here:
--
--   inspected_on   635/635. THE date. This is what the two-business-day alert
--                  measures against.
--   unit_turn_id   202/635. The inspection's unit turn. A STRUCTURAL link to a
--                  move-out: no name to read and nothing to misspell, which is
--                  the whole problem with keying on inspection_name (388 of
--                  635 carry a name nobody can classify).
--   unit_id        453/635, occupancy_id 76/635. Kept because they are joins
--                  somebody will want and the cost of carrying them is nothing.
--
-- inspection_date is NOT dropped. It is null everywhere, and dropping a column
-- is a different decision from stopping writing to it — this migration does the
-- second only.

alter table maintenance_inspections
  add column if not exists inspected_on date,
  add column if not exists unit_turn_id text,
  add column if not exists unit_id      text,
  add column if not exists occupancy_id text;

-- "Which inspections belong to this turn" is the alert's main question.
create index if not exists maintenance_inspections_turn_idx
  on maintenance_inspections (unit_turn_id);

create index if not exists maintenance_inspections_inspected_idx
  on maintenance_inspections (inspected_on desc);

comment on column maintenance_inspections.inspected_on is
  'The date from inspection_detail. Use this, not inspection_date, which the report does not return.';
comment on column maintenance_inspections.inspection_date is
  'Dead: inspection_detail has no such column. Null on every row. Kept so existing rows are not rewritten.';
comment on column maintenance_inspections.unit_turn_id is
  'The unit turn this inspection belongs to. Primary signal for "is this the move-out walk".';

-- Verify, AFTER the next inspections sync:
--   select count(*) filter (where inspected_on is not null) as dated,
--          count(*) filter (where unit_turn_id is not null) as linked,
--          count(*) from maintenance_inspections;
