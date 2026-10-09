-- 085 — the columns Kara's "last report → current" comparison needs.
--
-- NOT RUN YET. Arturo reviews this before it goes near Supabase (2026-10-09).
--
-- 083 created kpi_property_snapshots with four of Kara's five figures. She
-- named five on 2026-10-09: occupancy, projected occupancy, delinquency, total
-- income collected and RENEWALS. Renewals has no column, so this adds it.
--
-- `notices` comes with it, and is not optional. Projected occupancy is
-- (occupied - notices + preleased-not-yet-moved-in) / units, and a stored
-- PERCENTAGE cannot be re-aggregated — averaging two properties' projected
-- occupancy weights a 12-unit property like a 200-unit one. 083 already stores
-- units / occupied / preleased for exactly this reason and stopped one column
-- short of being able to recompute the projection it stores.
--
-- Nothing here drops or rewrites a column: every snapshot already written
-- keeps its values and gets nulls for the new ones. A null reads as "this
-- week was captured before we recorded it", which is true, and is not the same
-- as a zero.

alter table kpi_property_snapshots
  add column if not exists renewals      integer,
  add column if not exists did_not_renew integer,
  -- Units on notice at capture time: the subtraction in the projection.
  add column if not exists notices       integer,
  -- Open and closed code violations (Kara, same conversation: "open and
  -- closed, total transparency"). Stored with the rest because a violation
  -- count that only ever shows today's number cannot show work being finished.
  add column if not exists cv_open       integer,
  add column if not exists cv_closed     integer;

comment on column kpi_property_snapshots.occupancy_projected is
  'Occupancy allowing for notices and preleases, as a fraction. Kara, '
  '2026-10-09: current occupancy taking notices and preleased units into '
  'account. Stored for reading; any roll-up is recomputed from units, '
  'occupied, notices and preleased, never averaged across properties.';

comment on column kpi_property_snapshots.notices is
  'Units on notice when the snapshot was taken. Kept so occupancy_projected '
  'can be recomputed for a group rather than averaged.';

comment on column kpi_property_snapshots.renewals is
  'Leases renewed during the week. Kara asked for this in the week-on-week '
  'comparison; 083 had no column for it.';
