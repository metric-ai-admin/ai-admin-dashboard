-- 083 — weekly per-property snapshots, and the KPI fields Bekah and Kara edit.
--
-- NOT RUN YET. Arturo reviews this before it goes near Supabase (2026-10-08).
--
-- From the discovery with Kara. Two things, and they are deliberately separate
-- tables because they answer different questions and one of them is evidence.
--
-- kpi_property_snapshots — what a property looked like at the end of a week.
--   The report is computed live from whatever the sync holds TODAY, so last
--   week's figures change under us as rows arrive late. A week-on-week
--   comparison needs a number that was true on the Saturday and stays true, and
--   none of the sources we read keeps history: leasing_occupancy is a snapshot
--   keyed on property, and the delinquency and work-order stores are replaced
--   on every pull. Written once per week, never recomputed.
--
-- kpi_field_notes — the four editable fields Kara named: delinquency notes,
--   renewal comments, traffic adjustments and unit transfers. Separate from
--   kpi_manual_overrides (082), which replaces a COMPUTED NUMBER and therefore
--   has to carry the figure it replaced. These add something the report never
--   computed, so there is nothing to keep beside them.
--
-- Nothing reads either table yet. The allow-list in server.js is still empty
-- and stays empty until Bekah and Kara confirm the field names.

-- ---------------------------------------------------------------------------
create table if not exists kpi_property_snapshots (
  week_ending   date        not null,     -- always a Saturday; leasing weeks are Sun-Sat
  property      text        not null,     -- a real property, a group, or 'Portfolio'

  -- The four Kara asked to see against the previous week.
  occupancy_pct        numeric,
  occupancy_projected  numeric,           -- preleased / units: occupied + vacant rented
  delinquency_total    numeric,
  rent_collected       numeric,

  -- The numerators and denominators behind them. A stored percentage cannot be
  -- re-aggregated — averaging two properties' occupancy weights a 12-unit
  -- property like a 200-unit one — so the parts are kept and any roll-up is
  -- recomputed from them.
  units         integer,
  occupied      integer,
  preleased     integer,

  -- Where each figure came from, in the report's own vocabulary:
  -- appfolio | workbook | manual | unavailable. A snapshot that cannot say
  -- which of its numbers were adjusted by hand is not evidence of anything.
  sources       jsonb       not null default '{}'::jsonb,

  captured_at   timestamptz not null default now(),
  captured_by   text,
  primary key (week_ending, property)
);

comment on table kpi_property_snapshots is
  'What each property looked like at the end of a leasing week. Written once '
  'and not recomputed: the live report changes as late rows arrive, and a '
  'week-on-week comparison needs a figure that stays put.';

create index if not exists kpi_property_snapshots_week_idx
  on kpi_property_snapshots (week_ending desc);

-- ---------------------------------------------------------------------------
create table if not exists kpi_field_notes (
  week_ending  date        not null,
  property     text        not null,
  -- 'delinquency_note' | 'renewal_comment' | 'traffic_adjustment' |
  -- 'unit_transfer'. Text rather than an enum: Kara has not confirmed the
  -- names, and a fifth field should not need a migration on a deadline.
  field        text        not null,
  body         text,
  updated_by   text        not null,
  updated_at   timestamptz not null default now(),
  primary key (week_ending, property, field)
);

comment on table kpi_field_notes is
  'Notes Bekah and Kara add to the weekly KPI report: delinquency notes, '
  'renewal comments, traffic adjustments, unit transfers. Unlike '
  'kpi_manual_overrides these do not replace a computed number, so there is no '
  'computed value to keep beside them.';

create index if not exists kpi_field_notes_week_idx
  on kpi_field_notes (week_ending desc);

-- ---------------------------------------------------------------------------
-- Both are written only through the server, which holds the service role key.
-- No anon access is granted anywhere in this file.
