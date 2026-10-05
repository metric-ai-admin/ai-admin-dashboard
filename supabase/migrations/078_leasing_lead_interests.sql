-- 078_leasing_lead_interests.sql
--
-- Approved 2026-10-05. Reviewed as docs/proposed-leasing-lead-interests.sql.
-- ONE ROW PER INTEREST, which leasing_leads cannot hold.
--
-- leasing_leads upserts on appfolio_id = guest_card_uuid, one row per guest
-- CARD. The report is one row per INTEREST, so every interest after the first
-- on a card overwrites the one before. Measured 2026-10-05 for 09/27-10/03:
-- 136 interests in Katie's sheet became 79 rows, and 524 rows in the live pull
-- collapsed onto 479 cards. It also means the interest_received we store is
-- whichever interest happened to be last in the batch, not the first and not
-- each one.
--
-- WHY inquiry_id IS SAFE AS THE KEY. Probed live on 2026-10-05 against
-- guest_card_inquiries: 524 rows, inquiry_id filled on all 524, with 524
-- distinct values — one per interest. guest_card_uuid and guest_card_id both
-- showed 479 distinct, which is the card grain and the problem being fixed.
-- No composite of the other columns is unique: card + property + received
-- still collided on 6 of 136 rows in the workbook.
--
-- SCOPE. This table is additive. leasing_leads keeps its shape, its upsert key
-- and its role as the Goal Board's source; nothing here changes Traffic or any
-- number Katie reads. The two join on guest_card_uuid.

create table if not exists leasing_lead_interests (
  -- AppFolio's own id for the interest. Natural, unique, always present, so
  -- the sync is a plain idempotent upsert with no surrogate key and no
  -- last-seen reconciliation.
  inquiry_id            bigint primary key,

  -- Joins back to leasing_leads.appfolio_id. Not a foreign key on purpose: an
  -- interest can arrive in a pull where its card was filtered out, and a
  -- constraint would drop the row rather than record it.
  guest_card_uuid       text not null,
  guest_card_id         bigint,

  -- The report returns `property` (name PLUS address, "Ascent at Northgate -
  -- 9315 Northgate Blvd ...") and property_id. It does NOT return
  -- property_name, which is the field the current mapping reads — see the
  -- note at the bottom. Stored as given; split on ' - ' when a bare name is
  -- wanted.
  property              text,
  property_id           bigint,

  -- `received` in the API. Katie's "Guest Card Interests" sheet filters on
  -- this, so it is what the KPI comparison counts.
  interest_received     timestamptz not null,
  -- Traffic, per Lyndsay 2026-09-15, and what the Goal Board counts. The API
  -- returns a TIMESTAMP here ("2026-07-06T14:04:04Z"), not a date.
  first_contact_date    timestamptz,

  source                text,          -- "ILS Phone Lead", "Facebook Marketplace", …
  lead_type             text,          -- "Free" / paid
  status                text,          -- "Active", …
  inquiry_type          text,          -- "Voice Performer", … (5 distinct values live)

  -- Card-level counters the API repeats on every interest row of that card.
  -- They do NOT vary per interest; kept because interests_received_in_range
  -- may give Katie's count directly without counting rows, which is worth
  -- checking before anything relies on counting.
  interests_received_in_range  integer,
  total_interests_received     integer,
  showings              integer,
  follow_ups            integer,

  last_activity_date    timestamptz,
  synced_at             timestamptz not null default now()
);

create index if not exists leasing_lead_interests_received_idx
  on leasing_lead_interests (interest_received);
create index if not exists leasing_lead_interests_card_idx
  on leasing_lead_interests (guest_card_uuid);
create index if not exists leasing_lead_interests_prop_week_idx
  on leasing_lead_interests (property_id, interest_received);
create index if not exists leasing_lead_interests_first_contact_idx
  on leasing_lead_interests (first_contact_date);

-- The sync writes it as:
--
--   db.from('leasing_lead_interests')
--     .upsert(rows, { onConflict: 'inquiry_id' })
--
-- Leads for a week, Katie's definition (one row per interest):
--
--   select count(*) from leasing_lead_interests
--    where interest_received >= '2026-09-27' and interest_received < '2026-10-04';
--
-- Leads for a week, Traffic (one row per card, first contact):
--
--   select count(distinct guest_card_uuid) from leasing_lead_interests
--    where first_contact_date >= '2026-09-27' and first_contact_date < '2026-10-04';
--
-- To undo:  drop table leasing_lead_interests;
-- Nothing reads it until the sync is written, so dropping it costs nothing.

-- ---------------------------------------------------------------------------
-- ONE THING TO SETTLE BEFORE THE SYNC IS WRITTEN, not before this table exists.
--
-- APPFOLIO_LEASING_FIELDS.property points at 'property_name'. The report we
-- actually fetch, guest_card_inquiries, does not return that field at all, so
-- leasingRowFromReport falls through to resolving property_id against a map
-- built from previously-synced rows. A property with no prior rows resolves to
-- nothing and its leads are dropped. Writing this table's sync off the same
-- mapping would inherit that. `property` and property_id are both on every
-- row, so this table reads them directly and does not.
