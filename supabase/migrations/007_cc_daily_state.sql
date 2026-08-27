-- Command Center — daily state
--
-- Everything the Command Center knows lived in browser memory: the generated
-- tasks, the ticks, the progress ring. A reload — or a laptop going to sleep —
-- lost a morning's work with nothing to recover it from.
--
-- Keyed by date, not by user. Erick is the only person who works this board, and
-- the state is the day's, so two browsers open on the same day converge instead
-- of forking.
--
-- Run in the Supabase SQL editor. Every statement is IF NOT EXISTS and safe to
-- re-run; the editor does not honour BEGIN/COMMIT.

create table if not exists cc_daily_state (
  id              uuid primary key default gen_random_uuid(),
  state_date      date not null unique,
  tasks           jsonb not null default '[]'::jsonb,
  checks          jsonb not null default '{}'::jsonb,
  total_tasks     int not null default 0,
  completed_tasks int not null default 0,
  generated_at    timestamptz,
  updated_at      timestamptz not null default now()
);

-- Redundant with the unique constraint above, which already builds an index on
-- state_date. Created anyway because it was specified, and IF NOT EXISTS makes
-- it free to keep; drop it if the duplicate ever bothers anyone.
create index if not exists cc_daily_state_date_idx on cc_daily_state (state_date);

-- Rows older than a week are pruned by the server on every save, so no
-- scheduled job is needed. Nothing reads them: the Command Center asks only for
-- today, and yesterday's board is not something anyone goes back to.

-- Check:
-- select state_date, total_tasks, completed_tasks, updated_at
-- from cc_daily_state order by state_date desc;
