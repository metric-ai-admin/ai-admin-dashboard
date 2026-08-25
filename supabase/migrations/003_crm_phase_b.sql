-- BD CRM — Phase B: the three inputs the task engine was missing
-- Run this in the Supabase SQL Editor for project: metric-bd-crm
--
-- crm-task-engine.js carries four TODO(phase-b) markers. This migration
-- supplies the data for three of them; the fourth (rop_status semantics) is a
-- mapping question for Lyndsay, not a schema change.
--
-- Nothing here is destructive: two nullable/defaulted columns on `properties`
-- and one new table. Existing rows keep working — the defaults mean every
-- property starts with no owner response and no contact-update hold, which is
-- exactly today's behaviour.

-- ── 1. Owner response ────────────────────────────────────────────────────────
-- Feeds the engine's single largest term: +1000 priority, ahead of everything.
-- Two columns rather than the original's {date, handled} JSON blob, because the
-- property modal saves flat key/value pairs — a JSON column would need special
-- handling on both read and write, and would not be queryable like this.

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS owner_response_at      DATE,
  ADD COLUMN IF NOT EXISTS owner_response_handled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN properties.owner_response_at IS
  'Date the owner responded to outreach. Set = an owner_response task until handled.';
COMMENT ON COLUMN properties.owner_response_handled IS
  'Lyndsay has dealt with the response; clears the task without losing the date.';

-- Partial index: the engine only ever looks for unhandled responses.
CREATE INDEX IF NOT EXISTS idx_properties_owner_response
  ON properties (owner_response_at)
  WHERE owner_response_handled = FALSE;


-- ── 2. Contact update hold ───────────────────────────────────────────────────
-- The original's `holdShops`. When true the engine emits a contact_update task
-- (+180) and SUPPRESSES that property's phone, online and DM tasks — you cannot
-- shop a property you cannot reach. The UI label says so explicitly, because
-- three tasks disappearing is surprising otherwise.

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS needs_contact_update BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN properties.needs_contact_update IS
  'Contact details are stale. Suppresses phone/online/DM tasks and raises a contact_update task.';

CREATE INDEX IF NOT EXISTS idx_properties_needs_contact_update
  ON properties (needs_contact_update)
  WHERE needs_contact_update = TRUE;


-- ── 3. Targeted management companies ─────────────────────────────────────────
-- Worth +150 priority — the second-strongest term after owner response.
--
-- This list already exists in the UI but is written to browser localStorage
-- only, so it is per-person and the server has never been able to see it.
-- Moving it here makes it shared and visible to the engine.

CREATE TABLE IF NOT EXISTS targeted_companies (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Normalized, like properties_name_normalized_unique. A plain index on the raw
-- column would admit "Greystar", "greystar" and "Greystar " as three separate
-- targets, and the engine matches on the normalized form anyway.
CREATE UNIQUE INDEX IF NOT EXISTS targeted_companies_name_unique
  ON targeted_companies (lower(btrim(company_name)));

-- The dashboard connects with the service_role key, which bypasses RLS.
-- Enabling it with no policies means nothing else can reach this table.
ALTER TABLE targeted_companies ENABLE ROW LEVEL SECURITY;


-- ── Verification ─────────────────────────────────────────────────────────────
-- Expect: 3 new columns on properties, 0 rows in targeted_companies.
--
-- SELECT column_name, data_type, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'properties'
--   AND column_name IN ('owner_response_at','owner_response_handled','needs_contact_update')
-- ORDER BY column_name;
--
-- SELECT COUNT(*) AS targeted FROM targeted_companies;
