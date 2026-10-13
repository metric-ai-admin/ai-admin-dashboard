-- 088 — the thresholds that decide what goes red on Kara's 6 AM brief.
--
-- NOT RUN YET. Arturo reviews this before it goes near Supabase (2026-10-13).
--
-- WHY A TABLE AND NOT A CONSTANT. Kara has not used this report yet. The first
-- week will show that $5,000 is too low or too high, that seven days of
-- make-ready is normal here, that three days on an application is a Tuesday.
-- Every one of those is a number she should be able to change over coffee, and
-- none of them is worth a deploy.
--
-- PER PROPERTY, WITH A PORTFOLIO DEFAULT. property = '*' is the default every
-- property inherits; a row naming a property overrides it for that one. Windy
-- Hill at 72 units and iConic Downtown at 19 do not have the same idea of a
-- large delinquency, and the first thing anyone will want is to say so for one
-- property without moving everybody.
--
-- OCCUPANCY IS DELIBERATELY ABSENT. "Below the property's goal" already has an
-- answer — leasingGoalPct(), the same GOAL_OVERRIDE the Goal Board reads — and
-- a second place to set an occupancy target is a second place for it to
-- disagree with the board Kara reads on Mondays.

create table if not exists brief_thresholds (
  -- '*' is the portfolio default. Anything else is a property name as the
  -- report spells it.
  property            text        not null default '*',

  -- Delinquency total, in dollars, above which the property goes red.
  delinquency_over    numeric,
  -- An open make-ready older than this many days.
  make_ready_days     integer,
  -- A pending application older than this many days.
  application_days    integer,

  -- Who changed it and when. These numbers decide what a VP sees first thing
  -- in the morning, so a change to them is worth being able to trace.
  updated_by          text,
  updated_at          timestamptz not null default now(),
  note                text,

  primary key (property)
);

comment on table brief_thresholds is
  'What turns a property red on the 6 AM brief. One row per property plus a '
  '''*'' default row that the others inherit from. Occupancy is NOT here: it '
  'uses the Goal Board''s own per-property goal, so the two cannot disagree.';

comment on column brief_thresholds.property is
  '''*'' is the portfolio default. A property name overrides it for that one.';

-- The defaults Arturo proposed and Kara has not yet adjusted. Inserted only if
-- the row is absent, so re-running this never overwrites a number she set.
insert into brief_thresholds (property, delinquency_over, make_ready_days, application_days, updated_by, note)
values ('*', 5000, 7, 3, 'migration 088', 'proposed defaults, 2026-10-13 — Kara has not reviewed these yet')
on conflict (property) do nothing;

-- Verify:
--
--   select property, delinquency_over, make_ready_days, application_days,
--          updated_by, updated_at
--     from brief_thresholds order by (property = '*') desc, property;
