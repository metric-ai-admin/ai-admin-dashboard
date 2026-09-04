-- 029_property_phone.sql
--
-- The BD CRM Phone Shop tab shows a "Call <number> — put on speaker…" mystery-
-- shop instruction, but the properties table had no leasing-line phone column
-- (owner_phone is the owner's contact, not the number an agent dials to shop the
-- property). This adds it so the Phone Shop tab can display the number and agents
-- can fill it in inline when it's missing.
--
-- Idempotent. Run in the Supabase SQL editor.

alter table properties add column if not exists property_phone text;
