-- 034_maintenance_work_orders_ids.sql
--
-- The Command Center builds the AppFolio work-order link from work_order_id /
-- service_request_id, and shows the vendor for vendor-assigned orders. Those
-- three fields are in the work_order.json response but weren't being stored, so
-- synced task cards showed "no link" and no vendor. Add them.
--
-- Idempotent. Run in the Supabase SQL editor.

alter table maintenance_work_orders add column if not exists work_order_id      text;
alter table maintenance_work_orders add column if not exists service_request_id text;
alter table maintenance_work_orders add column if not exists vendor             text;
