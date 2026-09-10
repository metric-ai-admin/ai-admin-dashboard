-- 048_phone_shops_concession_other.sql
--
-- BD CRM Phone Shop: free-text description shown when "Other" is chosen in the
-- Concession Offered dropdown (e.g., "$500 gift card").
--
-- Idempotent. Run in the Supabase SQL editor.

alter table phone_shops add column if not exists quote_concession_other text;
