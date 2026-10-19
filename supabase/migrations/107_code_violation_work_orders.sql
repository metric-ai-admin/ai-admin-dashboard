-- 107 — which work orders belong to which deficiency.
--
-- The tracker keeps them in one text cell per deficiency, and 8 of the 78
-- in-tracker rows are not a bare number: they read "23240-1 (was 22882-1)".
--
-- JAY'S REPORT USES THAT CELL AS A LITERAL KEY (cv-live.js: String(r.workOrder)
-- .trim(), looked up in an index of AppFolio work_order_number). So those 8
-- land in his "notFound" bucket — reported as work orders AppFolio does not
-- have, when AppFolio has both of them. The text is right; the key is wrong.
--
-- One row per (deficiency, work order), with the original cell kept whole:
-- if the parse is wrong, the text it came from is still there to compare
-- against. Same rule as the note columns the import did not drop.

create table if not exists code_violation_work_orders (
  id                 uuid primary key default gen_random_uuid(),

  deficiency_key     text not null,
  work_order_number  text not null,

  -- 'current'  the work order the deficiency is on now
  -- 'replaced' one it used to be on, named inside the same cell
  role               text not null default 'current',

  -- For a replaced row: the number that took over. Null on current rows.
  replaced_by        text,

  -- THE CELL, UNTOUCHED. Not for display — for the next person who doubts the
  -- parse, which is the only way a parse gets corrected.
  raw_text           text not null,

  -- Order of appearance in the cell, so "23240-1 (was 22882-1)" keeps its
  -- sense when two numbers have the same role.
  position           integer not null default 0,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- A work order can appear once per deficiency per role: the same number
-- listed twice in one cell is one fact, and re-parsing must not double it.
create unique index if not exists code_violation_work_orders_uniq
  on code_violation_work_orders (deficiency_key, work_order_number, role);

create index if not exists code_violation_work_orders_wo_idx
  on code_violation_work_orders (work_order_number);
create index if not exists code_violation_work_orders_def_idx
  on code_violation_work_orders (deficiency_key, role);

comment on table code_violation_work_orders is
  'Deficiency -> work order. One row per pair. The tracker cell is kept in raw_text; Jay''s report uses that cell as a literal key and misses every replacement.';
comment on column code_violation_work_orders.role is
  '''current'' or ''replaced''. A replaced work order is still part of the history of the deficiency and is not deleted.';
comment on column code_violation_work_orders.raw_text is
  'The tracker cell this row was parsed from, unmodified. The parse is checkable because this is here.';

-- Verify:
--   select role, count(*) from code_violation_work_orders group by 1;
--   select deficiency_key, string_agg(work_order_number || ':' || role, ' ')
--     from code_violation_work_orders group by 1 having count(*) > 1;
