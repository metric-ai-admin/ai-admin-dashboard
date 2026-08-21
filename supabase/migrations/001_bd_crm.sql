-- BD CRM — Metric Property Management
-- Run this in the Supabase SQL Editor for project: metric-bd-crm
-- https://fqjgjssfitpilztthase.supabase.co

-- ── 1. properties ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS properties (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Property identity
  property_name       TEXT,
  address             TEXT,
  city                TEXT,
  state               TEXT DEFAULT 'TX',
  zip                 TEXT,
  submarket           TEXT,
  style               TEXT,              -- "Garden", "Mid-Rise", etc.
  year_built          INTEGER,
  asset_class         TEXT,              -- "A", "B", "C"
  units               INTEGER,

  -- Financials / market data
  vacancy_pct         NUMERIC(5,2),
  avg_asking_unit     NUMERIC(10,2),
  avg_unit_sf         NUMERIC(8,2),

  -- Management
  management_company  TEXT,
  management_type     TEXT,              -- "Third-party", "In-house"

  -- Owner info
  owner_name          TEXT,
  owner_contact_name  TEXT,
  owner_phone         TEXT,
  owner_email         TEXT,
  owner_address       TEXT,

  -- Assignees
  assigned_to         TEXT,             -- primary BD rep
  phone_assignee      TEXT,
  phone_assignee3     TEXT,
  online_dm_assignee  TEXT,

  -- Status / scoring
  rop_status          TEXT,             -- "Active", "Closed", "Prospect", etc.
  lead_score_override INTEGER,
  lyndsay_reviewed    BOOLEAN DEFAULT FALSE,
  notes               TEXT,

  -- Timestamps
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_properties_assigned_to    ON properties(assigned_to);
CREATE INDEX IF NOT EXISTS idx_properties_submarket      ON properties(submarket);
CREATE INDEX IF NOT EXISTS idx_properties_rop_status     ON properties(rop_status);
CREATE INDEX IF NOT EXISTS idx_properties_asset_class    ON properties(asset_class);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

CREATE OR REPLACE TRIGGER trg_properties_updated_at
  BEFORE UPDATE ON properties
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── 2. phone_shops ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS phone_shops (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,

  shop_date       DATE,
  agent_name      TEXT,
  call_duration   INTEGER,              -- seconds
  score           NUMERIC(4,1),
  greeting        TEXT,
  product_knowledge TEXT,
  closing         TEXT,
  notes           TEXT,
  audio_url       TEXT,

  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_phone_shops_property ON phone_shops(property_id);


-- ── 3. online_shops ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS online_shops (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,

  shop_date       DATE,
  platform        TEXT,                -- "Apartments.com", "Zillow", etc.
  score           NUMERIC(4,1),
  response_time_hrs NUMERIC(5,1),
  photos_quality  TEXT,
  listing_accuracy TEXT,
  notes           TEXT,

  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_online_shops_property ON online_shops(property_id);


-- ── 4. follow_ups ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS follow_ups (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,

  follow_up_date  DATE,
  method          TEXT,                -- "Email", "Phone", "LinkedIn", etc.
  contact_name    TEXT,
  outcome         TEXT,                -- "Left VM", "Responded", "No answer", etc.
  next_action     TEXT,
  next_action_date DATE,
  completed       BOOLEAN DEFAULT FALSE,
  notes           TEXT,

  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_follow_ups_property       ON follow_ups(property_id);
CREATE INDEX IF NOT EXISTS idx_follow_ups_date           ON follow_ups(follow_up_date);
CREATE INDEX IF NOT EXISTS idx_follow_ups_completed      ON follow_ups(completed);


-- ── 5. outreach_drafts ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outreach_drafts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,

  channel         TEXT,                -- "Email", "LinkedIn DM", "Letter", etc.
  subject         TEXT,
  body            TEXT,
  status          TEXT DEFAULT 'draft', -- "draft", "approved", "sent"
  approved_by     TEXT,
  sent_at         TIMESTAMPTZ,
  notes           TEXT,

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outreach_drafts_property ON outreach_drafts(property_id);
CREATE INDEX IF NOT EXISTS idx_outreach_drafts_status   ON outreach_drafts(status);

CREATE OR REPLACE TRIGGER trg_outreach_drafts_updated_at
  BEFORE UPDATE ON outreach_drafts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── Row Level Security (RLS) — optional, enable if you add auth ───────────────
-- ALTER TABLE properties      ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE phone_shops     ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE online_shops    ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE follow_ups      ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE outreach_drafts ENABLE ROW LEVEL SECURITY;
