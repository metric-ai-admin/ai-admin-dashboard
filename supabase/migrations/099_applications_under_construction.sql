-- 099 — hold a property's applications out of the brief while its units are
-- under construction.
--
-- Rocío, 2026-10-15: Windy Hill's old applications are for units still being
-- built. They do not follow the normal rules — nobody is sitting on a decision
-- — so they belong in neither the pending-application alerts nor "Records to
-- clean up" until Sammy and Bekah say how to treat them.
--
-- WHY A PROPERTY FLAG AND NOT THE UNIT-LEVEL FILTER THAT WAS ASKED FOR.
-- "Building 3, or units with no CO" cannot be expressed against the data we
-- have: leasing_applications carries no unit. All 46 Windy Hill rows have unit
-- NULL, because the AppFolio report does not return one. A filter written
-- against a column that is always null would exclude everything or nothing,
-- and look like it was doing the finer job either way.
--
-- So the switch is per property, it is OFF everywhere by default, and the
-- brief SAYS the property's applications are being held out and why. A
-- property quietly missing from an alert list is indistinguishable from a
-- property with nothing wrong — which is the thing this whole brief is built
-- to avoid.
--
-- When the unit reaches the data, this becomes the fallback rather than the
-- mechanism.

alter table brief_thresholds
  add column if not exists applications_excluded boolean;

alter table brief_thresholds
  add column if not exists applications_excluded_note text;

comment on column brief_thresholds.applications_excluded is
  'TRUE holds this property''s applications out of the pending-application flags AND out of Records to clean up. NULL/false = normal. The brief says so when it is on.';
comment on column brief_thresholds.applications_excluded_note is
  'Shown in the brief next to the exclusion, e.g. "units under construction — Sammy/Bekah to decide". Without it the brief prints a generic reason.';

-- Turn it on for Windy Hill:
--   insert into brief_thresholds (property, applications_excluded, applications_excluded_note)
--   values ('Windy Hill Apartment', true,
--           'units under construction — waiting on Sammy and Bekah')
--   on conflict (property) do update
--     set applications_excluded = excluded.applications_excluded,
--         applications_excluded_note = excluded.applications_excluded_note;

-- Verify:
--   select property, applications_excluded, applications_excluded_note
--     from brief_thresholds where applications_excluded;
