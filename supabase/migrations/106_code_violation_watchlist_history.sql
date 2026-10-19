-- 106 — keep a watchlist row before it is removed.
--
-- Arturo, 2026-10-19: "antes de borrar, guárdala en el historial/log como
-- hicimos con otras correcciones."
--
-- activity_log cannot do this. Its columns are event, section, resource,
-- method, status_code, action, entity_type, entity_id — it records THAT
-- something happened, not WHAT the row contained. Deleting with only that
-- behind it leaves an audit trail pointing at something nobody can read back.
--
-- So this is the call_grades_history shape, which already solved the same
-- problem: the complete row as jsonb, plus the few fields worth answering
-- without digging into it. A file on one laptop was tried once for a backup
-- and judged not durable; it was right.

create table if not exists code_violation_watchlist_history (
  id             uuid primary key default gen_random_uuid(),

  -- The row's own id before it was removed, so the deletion can be traced
  -- back from anything that referenced it.
  watchlist_id   uuid not null,

  -- The COMPLETE row as it stood before the delete. Source of truth.
  previous       jsonb not null,

  -- Denormalised out of `previous` so "what did we remove from iConic Round
  -- Rock" is answerable without reading jsonb. Redundant by design.
  property_name  text,
  work_order     text,
  title          text,

  -- Why it went, in words. 'duplicate of <id>' for this one.
  reason         text not null,
  removed_by     text not null,
  removed_at     timestamptz not null default now()
);

create index if not exists code_violation_watchlist_history_wl_idx
  on code_violation_watchlist_history (watchlist_id);

comment on table code_violation_watchlist_history is
  'Watchlist rows kept before deletion. activity_log records that something happened; this records what it was.';
comment on column code_violation_watchlist_history.previous is
  'The complete row before the delete — enough to put it back by hand.';

-- Verify:
--   select removed_at, property_name, title, reason
--     from code_violation_watchlist_history order by removed_at desc;
