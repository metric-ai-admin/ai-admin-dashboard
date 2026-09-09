-- 047_phone_shops_time_quote.sql
--
-- BD CRM Phone Shop form additions:
--   call_time        — time of the call (HH:MM)
--   quote_floorplan  — floorplan quoted on an agent-answered call
--   quote_price      — price offered ($/mo)
--   quote_concession — concession offered (None / 1 week free / … / Other)
--
-- Idempotent. Run in the Supabase SQL editor.

alter table phone_shops add column if not exists call_time        text;
alter table phone_shops add column if not exists quote_floorplan  text;
alter table phone_shops add column if not exists quote_price      numeric;
alter table phone_shops add column if not exists quote_concession text;
