-- 032_leasing_leads_guest_card_fields.sql
--
-- Extra fields captured from AppFolio's guest_cards.json (Guest Card Interests)
-- report. guest_card_uuid is the stable per-guest-card identifier now used as
-- leasing_leads.appfolio_id (the upsert key), and is also stored on its own for
-- reference/joins.
--
-- Idempotent. Run in the Supabase SQL editor.

alter table leasing_leads add column if not exists guest_card_id   integer;
alter table leasing_leads add column if not exists guest_card_uuid text;
alter table leasing_leads add column if not exists status          text;
alter table leasing_leads add column if not exists lead_type       text;
alter table leasing_leads add column if not exists property_id     text;

create index if not exists leasing_leads_guest_card_uuid_idx on leasing_leads (guest_card_uuid);
