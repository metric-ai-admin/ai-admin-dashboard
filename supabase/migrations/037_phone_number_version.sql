-- 037_phone_number_version.sql
--
-- Supports the "New Phone Number" reset: when a property's leasing-line number
-- changes, the 3-attempt phone-shop cycle starts over. Each phone_shop is tagged
-- with the property's phone_number_version at the time it was logged; the task
-- engine only counts shops whose version matches the property's current version,
-- so older-number shops don't count toward the new cycle (and the same agent may
-- shop the new number).
--
-- Idempotent. Run in the Supabase SQL editor.

alter table properties  add column if not exists phone_number_version integer default 0;
alter table phone_shops add column if not exists phone_number_version integer default 0;
