-- 080_lead_interests_rekey.sql
--
-- NOT RUN YET. Approved 2026-10-06, pending LEAD_DEDUP_HMAC_KEY existing in
-- Render. Read the "before you run this" block at the bottom first.
--
-- Re-keys leasing_lead_interests onto the report that actually matches
-- Lyndsay's numbers.
--
-- WHY THE 078 TABLE IS DROPPED AND NOT MIGRATED. It was keyed on inquiry_id,
-- which exists only on guest_card_inquiries — and that is a different
-- population, not a different shape of the same one: 84 rows for 09/27-10/03
-- where her report has 136. Its 527 rows describe something else. Keeping them
-- beside rows from guest_cards would make one table mean two things.
--
-- WHY (guest_card_uuid, interest_received). Measured on the live 136 rows,
-- 2026-10-06: 136 distinct, zero collisions. The uuid ALONE collides 44 times —
-- one guest card registering several interests, two of them 14 seconds apart —
-- so the timestamp's seconds are load-bearing, not decoration. Adding
-- property_id, source or last_activity_date changes nothing: two columns are
-- already unique.

drop table if exists leasing_lead_interests;

create table leasing_lead_interests (
  guest_card_uuid     text        not null,
  interest_received   timestamptz not null,
  primary key (guest_card_uuid, interest_received),

  property            text,        -- name plus address, as the report gives it
  property_id         bigint,
  first_contact_date  timestamptz, -- Traffic, per Lyndsay 2026-09-15
  source              text,
  lead_type           text,
  status              text,

  -- ── dedup_key ───────────────────────────────────────────────────────────
  -- HMAC-SHA256, keyed on LEAD_DEDUP_HMAC_KEY, of Lyndsay's own dedup key as
  -- kpi_dashboard_17.html builds it: phone, else email, else name, each
  -- String(x).trim(), no lowercasing and no digit-stripping — because that is
  -- what her report does, and normalising it would change her number.
  --
  -- HMAC AND NOT A PLAIN SHA256. A bare hash of a phone number is not an
  -- anonymisation: there are ten billion US numbers, so a complete rainbow
  -- table is hours of GPU time and a few hundred GB, and every row would be
  -- reversible to a person. The secret key is what makes the digest useless to
  -- anyone who gets the table without also getting Render's environment.
  --
  -- Equal inputs hash equal, so counting distinct dedup_key per property gives
  -- exactly the number her screen shows. Nothing reads it except itself.
  dedup_key           text        not null,

  last_activity_date  timestamptz,
  synced_at           timestamptz not null default now()
);

create index if not exists leasing_lead_interests_received_idx
  on leasing_lead_interests (interest_received);
create index if not exists leasing_lead_interests_prop_idx
  on leasing_lead_interests (property_id, interest_received);
create index if not exists leasing_lead_interests_dedup_idx
  on leasing_lead_interests (dedup_key);
create index if not exists leasing_lead_interests_first_contact_idx
  on leasing_lead_interests (first_contact_date);

-- Leads for a week, her rule:
--
--   select count(distinct dedup_key)
--     from leasing_lead_interests
--    where interest_received >= '2026-09-27' and interest_received < '2026-10-04'
--    group by property_id;
--
-- with both iConic properties collapsed into one bucket by the caller, the way
-- her canonicalProperty() does.

-- ── BEFORE YOU RUN THIS ─────────────────────────────────────────────────────
--
-- 1. LEAD_DEDUP_HMAC_KEY must exist in Render first. Generate it with
--    `openssl rand -hex 32`. The sync REFUSES to write interests when it is
--    missing and says so, rather than falling back to an unkeyed hash — a
--    silent fallback would quietly produce the reversible digests this column
--    exists to avoid, and they would be indistinguishable from the real ones
--    afterwards.
--
-- 2. THE KEY IS PERMANENT. Change it and every existing dedup_key stops
--    matching the new ones: the same person would count as two leads across
--    the boundary. There is no re-keying without a full resync, because the
--    inputs are not stored — which is the entire point.
--
-- 3. No contact details are in this table and none should be added. If a
--    question needs a name, it is answered from leasing_leads, which is where
--    that data already lives and is already governed.
--
-- To undo: drop table leasing_lead_interests;
-- Nothing reads it until the sync is pointed at it.
