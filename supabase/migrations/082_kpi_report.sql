-- 082 — KPI Report phase 2: manual overrides and the workbook-only data.
--
-- NOT RUN YET. Arturo reviews this before it goes near Supabase (2026-10-07).
--
-- Two tables, for the two things the combined report cannot compute:
--
--   kpi_manual_overrides   numbers Bekah or Kara adjust by hand. The list of
--                          fields they may touch is EMPTY in code until they
--                          answer, so this table exists and accepts nothing.
--
--   kpi_workbook_data      what still has to come from Katie's workbook. The
--                          MTD financials, because income_statement returns 309
--                          rows whatever you ask it, ignores its filters and
--                          answers portfolio totals only — and her MTD Cash and
--                          MTD Accrual are per property, so a portfolio total
--                          cannot stand in. Plus Occupancy Goals, which is a
--                          hand-maintained tab and was never in AppFolio.
--
-- Both are keyed by week_ending, which is always a SATURDAY: leasing weeks are
-- Sun–Sat and the rest of the KPI report is keyed the same way.

-- ---------------------------------------------------------------------------
create table if not exists kpi_manual_overrides (
  week_ending  date        not null,
  -- 'Portfolio' for the roll-up, a virtual group name ('Greystone',
  -- 'Round Rock'), or a real property.
  property     text        not null,
  field        text        not null,
  -- jsonb, not numeric: a few of these fields are counts, one or two may end
  -- up being money, and one could be a short label. A column typed numeric
  -- would have to be migrated the first time somebody overrides a non-number.
  value        jsonb       not null,
  -- The number the report CALCULATED when the override was written. Kept so
  -- the page can show both — "18 (adjusted from 17 by Kara, 10/09)". An
  -- adjusted number that cannot be told from a computed one is the worst
  -- version of this feature.
  computed     jsonb,
  note         text,
  updated_by   text        not null,
  updated_at   timestamptz not null default now(),
  primary key (week_ending, property, field)
);

comment on table kpi_manual_overrides is
  'Hand adjustments to the weekly KPI report. Per (week, property, field). The '
  'set of writable fields is an allow-list in server.js and is empty until '
  'Bekah and Kara say which numbers they need to adjust.';

-- The report reads a whole week at once.
create index if not exists kpi_manual_overrides_week_idx
  on kpi_manual_overrides (week_ending);

-- ---------------------------------------------------------------------------
create table if not exists kpi_workbook_data (
  week_ending  date        not null,
  -- 'mtd_cash' | 'mtd_accrual' | 'occupancy_goals'. Text rather than an enum:
  -- adding a fourth sheet should not need a migration on a deadline.
  sheet        text        not null,
  -- Parsed rows, as the sheet gave them, keyed by property inside. Stored whole
  -- rather than shredded into columns because the shape is Katie's, not ours,
  -- and a column layout would have to change every time AppFolio moves one.
  data         jsonb       not null,
  -- Which file this came from and when, so the report can say "MTD figures
  -- from Katie's workbook, uploaded 10/09" instead of presenting them as live.
  filename     text,
  uploaded_by  text        not null,
  uploaded_at  timestamptz not null default now(),
  primary key (week_ending, sheet)
);

comment on table kpi_workbook_data is
  'The parts of the KPI report that still come from Katie''s Excel: MTD Cash, '
  'MTD Accrual and the hand-maintained Occupancy Goals tab. Replaced on each '
  'upload for that week.';

create index if not exists kpi_workbook_data_week_idx
  on kpi_workbook_data (week_ending);

-- ---------------------------------------------------------------------------
-- Both tables are written only through the server, which holds the service
-- role key; no anon access is granted anywhere in this file.
