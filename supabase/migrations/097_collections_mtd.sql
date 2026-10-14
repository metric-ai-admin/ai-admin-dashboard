-- 097 — month-to-date collections, captured daily, because AppFolio will not
-- tell us what last month looked like.
--
-- income_statement accepts properties: {properties_ids:["1703"]} and filters on
-- it — Ascent 56,335.98 against a portfolio 311,166.40, probed 2026-10-16. It
-- ignores EVERY date parameter tried, in every shape, so it answers one period
-- of its own choosing and there is no way to ask it about September.
--
-- So the history has to be ours. A row per property per capture day, and the
-- comparison Kara asked for — the 1st-to-the-14th against the 1st-to-the-14th
-- — becomes possible one month after this starts running, and not before. The
-- alert says so rather than reporting a flattering silence.
--
-- THE ACCOUNT BREAKDOWN IS STORED WHOLE, as jsonb, rather than reduced to one
-- number on the way in. Which accounts count as "cash receipts" is a question
-- Kara and Katie have not settled, and a sync that stores only today's answer
-- cannot be re-asked tomorrow — the same mistake as a projection that keeps
-- only the figure it computed. `rent_income` is denormalised out of it because
-- it is the line everything currently compares on.

create table if not exists collections_mtd (
  id            uuid primary key default gen_random_uuid(),

  -- The day we ASKED, in Central. Not the period the report describes: see
  -- `period_note`. Two different facts, and conflating them is how a snapshot
  -- becomes undated.
  captured_on   date not null,

  -- '*' for the portfolio total, so one query answers both.
  property      text not null,
  property_id   text,

  rent_income   numeric,
  total_income  numeric,

  -- Every income line the report returned: { "Rent Income": 56335.98, ... }.
  accounts      jsonb not null default '{}'::jsonb,

  -- What the report said about its own period, if anything, plus whatever we
  -- could work out. Carried so a reader never has to assume it is the current
  -- month.
  period_note   text,

  source        text not null default 'income_statement',
  created_at    timestamptz not null default now()
);

-- One capture per property per day. A second run the same day REPLACES it
-- rather than doubling the series.
create unique index if not exists collections_mtd_day_idx
  on collections_mtd (captured_on, property);

create index if not exists collections_mtd_property_idx
  on collections_mtd (property, captured_on desc);

comment on table collections_mtd is
  'Daily month-to-date collections per property. Our own history: income_statement cannot be asked about a past period.';
comment on column collections_mtd.captured_on is
  'The day we asked, Central. NOT the period the report covers — see period_note.';
comment on column collections_mtd.accounts is
  'Every income line as returned. Stored whole so "which accounts are cash receipts" can be re-answered without re-syncing.';

-- Verify:
--   select captured_on, count(*), sum(rent_income) filter (where property <> '*')
--     from collections_mtd group by 1 order by 1 desc limit 10;
