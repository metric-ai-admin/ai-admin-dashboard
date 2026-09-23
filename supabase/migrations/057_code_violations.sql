-- Code Violations Tracker — Jay Manuel's spec, 2026-09-23.
--
-- WHY A TABLE AND NOT A SYNCED REPORT. Jay's saved report
-- (/reports/joined_reports/66378e55-6e71-11f1-948b-0269bfa09cb1) was probed
-- live on 2026-09-23 and is NOT reachable from the API: the bare UUID answers
-- 400 "Id is not a valid report", the joined_reports path answers 404. There is
-- also no base report to fall back on, because work_order returns one row per
-- WORK ORDER and Jay's core rule is one row per CITED DEFICIENCY — in the
-- 09/17 workbook, 67 deficiencies sit across 24 work orders, and WO 22882-1
-- alone carries three separate citations. That grain exists only in the
-- workbook people maintain by hand, so it lives here.
--
-- Run in the Supabase SQL editor. Every statement is IF NOT EXISTS and safe to
-- re-run; the editor does not honour BEGIN/COMMIT.

-- ── The tracker ────────────────────────────────────────────────────────────
-- Case Number and Work Order both REPEAT across rows and neither is a key.
-- `deficiency_key` is the stable composite Jay specified — a hash of
-- case number + work order + building/unit + code section — computed in
-- code-violations.js so the same row imported twice updates rather than
-- duplicates.
create table if not exists code_violations (
  id              uuid primary key default gen_random_uuid(),
  deficiency_key  text not null unique,

  property_name   text not null,
  case_number     text,                      -- "2026-052660 CV", or "No CV number issued"
  work_order      text,                      -- "22882-1"
  address_unit    text,                      -- building / unit the citation names
  code_section    text,                      -- "605.1", parsed out of the description

  deficiency_date date,
  deficiency_description text,
  category        text,                      -- Electrical / Permitting / ...

  status          text not null,
  -- Set by a human only, never by an importer, and only by Jay or Bekah
  -- (answered 2026-09-23). The route enforces that; these columns record who
  -- and when, so a city-facing claim always has a name behind it.
  closed_by       text,
  closed_at       timestamptz,

  -- NULLABLE ON PURPOSE, and never derived. A due date means the city issued
  -- one. 13 of the 67 rows in the 09/17 workbook have one; the rest are blank
  -- because no deadline was given, which is not the same as "not due yet".
  due_date        date,
  notice_date     date,

  pending_items        text,
  completed_items      text,
  maintenance_remarks  text,
  client_vendor_remarks text,
  progress_notes       text,

  -- Human review gate. Set by the importer//rules, cleared by a person.
  unverified_closure      boolean not null default false,
  unverified_reason       text,
  verified_by             text,
  verified_at             timestamptz,

  -- Evidence, answered 2026-09-23: links rather than uploads. The documents
  -- already live somewhere (AppFolio work-order photos, the city's own portal,
  -- SharePoint), and copying them here would create a second copy to keep in
  -- step with the first. A link points at the original.
  city_notice_url      text,
  completion_photo_url text,

  source          text not null default 'manual',  -- 'manual' | 'excel' | 'appfolio'
  imported_at     timestamptz,
  updated_by      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists code_violations_property_idx on code_violations (property_name);
create index if not exists code_violations_status_idx   on code_violations (status);
create index if not exists code_violations_due_idx      on code_violations (due_date);

-- ── The watchlist ──────────────────────────────────────────────────────────
-- Real obligations that never appear in the AppFolio feed because nothing
-- tagged them a code violation. Kept in its own table rather than as a flag on
-- the tracker: these have no case number, no work order and often no city
-- behind them at all (Austin Public Health, Round Rock Fire Dept), so they
-- would make every column above nullable for the sake of a handful of rows.
create table if not exists code_violation_watchlist (
  id           uuid primary key default gen_random_uuid(),
  property_name text not null,
  title        text not null,
  authority    text,                 -- "Austin Public Health", "Round Rock Fire Dept"
  work_order   text,
  detail       text,
  status       text not null default 'Open',   -- 'Open' | 'Resolved'
  due_date     date,
  added_by     text,
  resolved_by  text,
  resolved_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists cv_watchlist_property_idx on code_violation_watchlist (property_name);

-- ── Seed: the three exceptions Jay named ───────────────────────────────────
-- Hyde Park Square 22461-1 is in here rather than the tracker BECAUSE it is a
-- tagging error — a resident's washer, not a code violation. It is recorded so
-- the next person to see it tagged that way knows it was already looked at,
-- instead of adding it to the tracker again.
insert into code_violation_watchlist (property_name, title, authority, work_order, detail, status, added_by)
select * from (values
  ('The Sidney', 'Pool permit', 'Austin Public Health', null,
   'Pool permit obligation that is not tagged as a Code Violation in AppFolio, so it never reaches the tracker feed.', 'Open', 'seed'),
  ('iConic Round Rock', 'Pool gate', 'Round Rock Fire Dept', '19105-1',
   'Pool gate cited by Round Rock Fire Dept. Not tagged as a Code Violation in AppFolio.', 'Open', 'seed'),
  ('Hyde Park Square', 'WO 22461-1 — resident washer, NOT a code violation', null, '22461-1',
   'Tagging error. This work order is a resident washer and must NOT be counted in the tracker or reported to the city or an owner. Logged here so it is not re-added.', 'Open', 'seed')
) as v(property_name, title, authority, work_order, detail, status, added_by)
where not exists (select 1 from code_violation_watchlist);
