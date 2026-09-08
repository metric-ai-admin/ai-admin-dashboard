-- 039_leasing_occupancy_property_id.sql
--
-- The occupancy_summary report returns one row PER UNIT TYPE per property and
-- carries a stable `property_id`. The sync now aggregates by property_id, so
-- leasing_occupancy needs that id (unique, for the upsert) plus the full
-- `property` string (community + address); property_name keeps just the clean
-- community name (substring before " - ").
--
-- Idempotent. Run in the Supabase SQL editor.

alter table leasing_occupancy add column if not exists property_id   integer;
alter table leasing_occupancy add column if not exists property      text;
alter table leasing_occupancy add column if not exists vacant_rented integer;  -- vacant but leased
alter table leasing_occupancy add column if not exists notice_units  integer;  -- on notice (rented + unrented)

-- property_id is stored for joins to leasing_leads; the sync still upserts on
-- the clean property_name (unique per property, per migration 038), which
-- avoids mixing conflict targets against that existing unique constraint.
create index if not exists leasing_occupancy_property_id_idx
  on leasing_occupancy (property_id);
