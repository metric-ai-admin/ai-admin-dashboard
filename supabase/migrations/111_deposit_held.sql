-- 111 — security deposits held, and when one stops being held.
--
-- Kara approved "deposit settled" as the signal for "FAS sent" (2026-10-20),
-- so the Final Account Statement section of her 06:00 brief can stop saying
-- NOT MEASURABLE. The source is AppFolio's `security_deposit_funds_detail`,
-- found by reading the report URLs in the admin UI after the catalogue 404'd
-- and 22 guessed names were rejected.
--
-- IT IS A LIST OF WHAT IS HELD TODAY, with no settlement date and no history.
-- A deposit that has been returned or applied simply is not in it any more. So
-- the date is derived: the row was here on Monday and gone on Tuesday, and the
-- settlement happened between those two days.
--
-- WHICH IS WHY THIS IS NOT A PILE OF DAILY PHOTOS. One row per occupancy with
-- first/last seen and a tombstone — the same in_feed pattern as lease_history,
-- applications, work orders and code violations — answers the question with
-- 215 rows instead of 215 a day, and the pair of dates carries the uncertainty
-- instead of hiding it behind a single date that looks exact.

create table if not exists deposit_held (
  occupancy_id    text primary key,

  -- What the report carries. It has NO property column, which is the one thing
  -- the brief is grouped by: property is resolved from occupancy_id through
  -- occupancy_custom_fields, and property_source records how — or that it
  -- could not be, which is a count in the email and not a dropped row.
  unit            text,
  property        text,
  property_source text,                     -- 'occupancy_custom_fields' | 'unresolved'
  tenant_status   text,
  move_in         date,
  move_out        date,
  amount          numeric,

  -- The two dates that bracket a settlement.
  first_seen_on   date not null,
  last_seen_on    date not null,
  in_feed         boolean not null default true,
  -- The first run that did NOT return it. Null while it is still held.
  gone_first_seen_on date,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists deposit_held_property_idx on deposit_held (property);
create index if not exists deposit_held_moveout_idx on deposit_held (move_out)
  where in_feed = true;
create index if not exists deposit_held_gone_idx on deposit_held (gone_first_seen_on);

comment on table deposit_held is
  'Security deposits AppFolio reports as held, one row per occupancy. A row that stops coming back has been settled: between last_seen_on and gone_first_seen_on.';
comment on column deposit_held.gone_first_seen_on is
  'First run that did not return this deposit. With last_seen_on it brackets the settlement — never read either one alone as "the date".';
comment on column deposit_held.property_source is
  'How the property was resolved. "unresolved" means the deposit is real and we could not place it: it is counted and named in the brief, never dropped.';

-- ---------------------------------------------------------------------------
-- EVERY RUN, INCLUDING THE BAD ONES.
--
-- "Disappeared from the list" means settled — so a run that returns zero rows
-- because AppFolio rate-limited us, or because a filter changed, would settle
-- all 215 deposits on the same day and report a perfect week on the morning
-- the sync broke. The sync refuses to settle anything when the count falls by
-- more than a fifth, and this table is where that refusal is written down.
--
-- It is also what makes the bracket honest. If the previous good run was three
-- days ago, the settlement happened within three days, not one, and the brief
-- says so rather than picking a day.
create table if not exists deposit_sync_runs (
  id            bigserial primary key,
  ran_on        date not null,
  ran_at        timestamptz not null default now(),
  rows_returned integer,
  -- 'ok' — counted and applied
  -- 'suspect' — the feed fell too far; nothing was settled
  -- 'failed' — the fetch itself did not come back
  status        text not null,
  -- The count the drop was measured against, and the drop itself.
  previous_rows integer,
  drop_pct      numeric,
  -- Counts by tenant_status, so "are these current residents too?" is a fact
  -- on the record and not a thing somebody remembers asking. No names.
  status_counts jsonb,
  settled       integer not null default 0,
  error         text
);

create index if not exists deposit_sync_runs_day_idx on deposit_sync_runs (ran_on desc);

comment on table deposit_sync_runs is
  'One row per snapshot attempt. A day with no row here is a day nobody looked — which the brief reports rather than treating as a day nothing happened.';
comment on column deposit_sync_runs.status is
  'ok | suspect (feed fell more than the guard allows; nothing settled) | failed.';

-- Verify:
--   select count(*) from deposit_held;
--   select ran_on, status, rows_returned, previous_rows, drop_pct, settled
--     from deposit_sync_runs order by ran_on desc limit 10;
--   -- the first real snapshot is taken by the 04:00 cron, not by this file
