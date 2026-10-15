-- 098 — the call-score threshold, and the portfolio grouping Kara has not
-- defined yet.
--
-- Two separate things, one migration, because both exist so that answering a
-- question later is a row in a table rather than a deploy.

-- ---------------------------------------------------------------------------
-- 1. The call-score threshold for the 6 AM brief.
--
-- NULL means the Call Analyzer's own boundary, 70 — where GRADE_BANDS in
-- server.js puts the line between C and D. That default is deliberate: if the
-- brief graded on a different number from the screen people actually look at,
-- "12 calls below 70" in the email and a green row in the tool would both be
-- correct and nobody could reconcile them.
--
-- Read the same way as the other thresholds: the property's own row, then the
-- '*' row, then the built-in.
alter table brief_thresholds
  add column if not exists call_score_min numeric;

comment on column brief_thresholds.call_score_min is
  'Calls scoring BELOW this are counted in Kara''s brief. NULL = 70, the Call Analyzer''s C/D boundary. Set per property or on the ''*'' row.';

-- ---------------------------------------------------------------------------
-- 2. Which portfolio each property belongs to.
--
-- Kara asked for the projection grouped by portfolio — RR and Greystone — and
-- has not yet said which properties go in each. The table is created EMPTY on
-- purpose.
--
-- An empty table is not a problem to be worked around: lib/brief-occupancy.js
-- reports every property as `ungrouped` and the brief prints that the split is
-- pending. Guessing an assignment from a name would produce two portfolio
-- totals that look authoritative and are made up, and nobody downstream could
-- tell which rows were guessed.
create table if not exists brief_portfolios (
  property    text primary key,
  portfolio   text not null,
  updated_at  timestamptz not null default now()
);

comment on table brief_portfolios is
  'Property -> portfolio (RR, Greystone) for the projected-occupancy grouping in Kara''s brief. EMPTY until Kara confirms the split; the brief says so rather than guessing.';

-- To fill in, once Kara confirms:
--   insert into brief_portfolios (property, portfolio) values
--     ('Ascent at Northgate', 'RR'), ('...', 'Greystone')
--   on conflict (property) do update set portfolio = excluded.portfolio,
--     updated_at = now();

-- Verify:
--   select property, call_score_min from brief_thresholds;
--   select * from brief_portfolios order by portfolio, property;
