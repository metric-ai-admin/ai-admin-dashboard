-- Unified Daily Operations Report — shell schema
--
-- Run in the Supabase SQL editor before deploying. Every statement stands alone
-- and is re-runnable: the editor does not honour BEGIN/COMMIT, which is what
-- cost us rows during the property dedup.

create table if not exists daily_reports (
  id          uuid primary key default gen_random_uuid(),
  report_date date not null,
  sections    jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now()
);

-- One report per day. Without this, pressing "Generate Report" twice would make
-- two reports for the same date, and sign-offs would scatter across both — half
-- the team signing a document the other half never saw.
create unique index if not exists daily_reports_date_key on daily_reports (report_date);

create table if not exists report_signoffs (
  id           uuid primary key default gen_random_uuid(),
  report_id    uuid not null references daily_reports(id) on delete cascade,
  user_name    text not null,
  confirmed_at timestamptz not null default now()
);

-- A sign-off is a statement of record, so it is written once and never revised.
-- There is no un-sign route; this stops a second one from being written on top,
-- normalised so 'Kara' and 'kara ' cannot both sign the same report.
create unique index if not exists report_signoffs_once_key
  on report_signoffs (report_id, lower(btrim(user_name)));

create table if not exists report_views (
  id        uuid primary key default gen_random_uuid(),
  report_id uuid not null references daily_reports(id) on delete cascade,
  user_name text not null,
  viewed_at timestamptz not null default now()
);

-- Append-only: one row per open, aggregated into first/last/count on read.
-- No unique index here — the repetition is the data.
create index if not exists report_views_report_idx on report_views (report_id, user_name);

-- Check: select count(*) from daily_reports;
