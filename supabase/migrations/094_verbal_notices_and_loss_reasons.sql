-- 094 — Kara's Phase C, items 2 and 3 (form of 2026-10-09).
--
-- Two unrelated things in one migration because they ship together; neither
-- touches an existing column.

-- ---- verbal notices --------------------------------------------------------
--
-- A resident tells somebody on site that they are leaving. That is not a
-- notice, and the point of this table is that the difference stays visible:
-- the row records that somebody SAID it, and `written_notice_received` stays
-- null until the real one arrives in the portal.
--
-- THE DASHBOARD DOES NOT WRITE THIS TO APPFOLIO. Nothing here is a filing.
--
-- Anybody signed in can add one (Arturo, 2026-10-14): a technician standing in
-- the unit is often the person who hears it, and a form only leasing can reach
-- is a form that does not get used.
create table if not exists verbal_notices (
  id            uuid primary key default gen_random_uuid(),

  property      text not null,
  unit          text,
  resident      text,

  -- When the resident SAID it, which is not when the row was created — the
  -- form is often filled in at the end of the day.
  notice_date   date not null,

  -- Who heard it. From the roster rather than typed, so "Angel" and "angel m"
  -- do not become two people.
  received_by   text not null,
  notes         text,

  -- Null until the resident files the real one in the portal. A verbal notice
  -- that is never followed up is the thing this column exists to make findable.
  written_notice_received date,

  created_by    text,
  created_at    timestamptz not null default now(),

  -- Who the immediate email reached, so a row cannot look notified when the
  -- send failed.
  notified_at   timestamptz,
  notify_error  text
);

create index if not exists verbal_notices_open_idx
  on verbal_notices (written_notice_received, notice_date desc);
create index if not exists verbal_notices_property_idx
  on verbal_notices (property, notice_date desc);

comment on table verbal_notices is
  'A resident said they are leaving. NOT a formal notice and never written to AppFolio.';

-- ---- lost-lead reasons -----------------------------------------------------
--
-- An editable list, and an OPTIONAL annotation on a lead.
--
-- IT CHANGES NO COUNT. Nothing in the Goal Board or the KPI report reads
-- leasing_leads.loss_reason, and test/moveout-and-notices.test.js asserts that
-- by reading their source — a promise nobody checks is a promise.
create table if not exists lead_loss_reasons (
  id          uuid primary key default gen_random_uuid(),
  label       text not null unique,
  sort_order  integer not null default 100,
  -- Retired rather than deleted. A reason removed from the list must not
  -- vanish from the leads already annotated with it: a history that changes
  -- when somebody edits a dropdown is not a history.
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

insert into lead_loss_reasons (label, sort_order) values
  ('Price', 10),
  ('Did not qualify', 20),
  ('Chose another property', 30),
  ('No response', 40),
  ('Area / location', 50),
  ('Objection to the unit', 60)
on conflict (label) do nothing;

alter table leasing_leads
  add column if not exists loss_reason text;

comment on column leasing_leads.loss_reason is
  'Optional annotation from lead_loss_reasons. Read by nobody that counts anything.';

-- Verify:
--   select label, active from lead_loss_reasons order by sort_order;
--   select count(*) from verbal_notices where written_notice_received is null;
