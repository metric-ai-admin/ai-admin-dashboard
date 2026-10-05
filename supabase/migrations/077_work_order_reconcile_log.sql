-- 077_work_order_reconcile_log.sql
--
-- What the reconciliation changed, so it can be undone.
--
-- 362 work orders change status in a single pass on the first run. "Put it
-- back the way it was" needs a record of the way it was, and a record that
-- survives the process exiting — the reconciliation also writes a JSON backup
-- to DATA_DIR, but a file on Render's disk is not somewhere anyone can query
-- at 7am when a number looks wrong.
--
-- Append-only. Nothing reads it in normal operation; it exists for the morning
-- somebody asks "why does this say Completed".
create table if not exists work_order_reconcile_log (
  id                bigserial primary key,
  run_at            timestamptz not null,

  work_order_number text not null,
  property_name     text,
  work_order_type   text,

  -- The whole point: what it was, before.
  status_before     text,
  status_after      text,
  completed_on      date,

  -- 'closed'  — AppFolio's completed report says so, and completed_on says when
  -- 'unknown' — it left the feed and never appeared as closed
  reason            text,

  created_at        timestamptz not null default now()
);

create index if not exists work_order_reconcile_log_run_idx
  on work_order_reconcile_log (run_at desc);
create index if not exists work_order_reconcile_log_wo_idx
  on work_order_reconcile_log (work_order_number);

-- To undo a run:
--
--   update maintenance_work_orders m
--      set status = l.status_before
--     from work_order_reconcile_log l
--    where l.work_order_number = m.work_order_number
--      and l.run_at = '<the run>';
--
-- To see what one work order has been through:
--
--   select run_at, status_before, status_after, reason
--     from work_order_reconcile_log
--    where work_order_number = '22847-1' order by run_at;
