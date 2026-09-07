-- 036_maintenance_audit.sql
--
-- Audit: unbilled slot for the Command Center — Work Done / Ready to Bill work
-- orders that still carry an unbilled amount (from work_order_billable_detail
-- filtered to unbilled_amount > 0). Merging a WO from here sets _src.audit, which
-- flags the "Unbilled over 30 days" task. Only work_order_number + unbilled_amount
-- are needed; property is kept for reference. Full-replaced each sync.
--
-- Idempotent. Run in the Supabase SQL editor.

create table if not exists maintenance_audit (
  id uuid primary key default gen_random_uuid(),
  work_order_number text,
  property          text,
  unbilled_amount   numeric,
  synced_at         timestamptz default now()
);
create index if not exists ma_wo_idx on maintenance_audit (work_order_number);
