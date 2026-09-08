-- 041_leasing_phase5_unique_constraints.sql
--
-- Phase 5b fix: the three sync routes upsert with onConflict on showing_id /
-- rental_application_id / lease_uuid. If any of those tables was created WITHOUT
-- the inline UNIQUE (e.g. an earlier `create table if not exists` ran against a
-- pre-existing table), the upsert fails with Postgres 42P10 ("no unique or
-- exclusion constraint matching the ON CONFLICT specification") and 0 rows land.
--
-- A unique INDEX is a valid ON CONFLICT target and `if not exists` makes this
-- safe to run whether or not the column already has a unique constraint.
--
-- Idempotent. Run in the Supabase SQL editor.

create unique index if not exists leasing_showings_showing_id_uidx
  on leasing_showings (showing_id);

create unique index if not exists leasing_applications_rai_uidx
  on leasing_applications (rental_application_id);

create unique index if not exists leasing_lease_history_uuid_uidx
  on leasing_lease_history (lease_uuid);
