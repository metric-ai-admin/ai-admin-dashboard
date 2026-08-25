-- Technicians — Metric Property Management (maintenance module)
-- Run this in the Supabase SQL Editor for project: metric-bd-crm
--
-- Consolidates five hardcoded lists that had drifted apart:
--   1. MAP_TECHS               (public/app.js)          — Coverage Map pins
--   2. Technician Capabilities (metric-dashboard HTML)  — skills matrix
--   3. Make Ready chips        (metric-dashboard HTML)  — MR roster
--   4. ACTIVE_TECHNICIANS      (appfolio-reports.js)    — zero-hours alert
--   5. property_assignments.maintenance_tech           — free text
--
-- Names, aliases and Rene Hernandez's surname were reconciled against the
-- maintenance_tech values in real AppFolio work_order_labor_summary rows.

-- ── Capability scale shared by the eight skill columns ───────────────────────
DO $$ BEGIN
  CREATE DOMAIN tech_cap AS TEXT
    CHECK (VALUE IN ('highest','yes','minor','maybe','no','na'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── technicians ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS technicians (
  id            TEXT PRIMARY KEY,           -- slug, e.g. 'angel-martinez'
  full_name     TEXT NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  position      TEXT NOT NULL DEFAULT 'maint_tech'
                CHECK (position IN ('field_supervisor','senior_maint_tech','maint_tech',
                                    'make_ready','housekeeper','grounds','other')),

  -- AppFolio reconciliation. AppFolio stores trailing initials and stray double
  -- spaces ('Angel Martinez C', 'Emerson  Garcia -'), so matching goes through
  -- this array rather than guessing from full_name.
  appfolio_aliases    TEXT[] NOT NULL DEFAULT '{}',
  -- Replaces the hardcoded ACTIVE_TECHNICIANS roster: who is expected to log
  -- hours on a normal working day. Drives the zero-hours alert.
  expect_daily_hours  BOOLEAN NOT NULL DEFAULT FALSE,

  -- Replaces MAP_TECHS. lat/lng are ZIP centroids — home AREA, not addresses.
  show_on_map   BOOLEAN NOT NULL DEFAULT FALSE,
  home_zip      TEXT,
  home_lat      DOUBLE PRECISION,
  home_lng      DOUBLE PRECISION,

  -- Replaces the Make Ready chips. Separate from `position` because the chip
  -- list also carried the housekeeper, with her own role note.
  shows_in_make_ready BOOLEAN NOT NULL DEFAULT FALSE,
  make_ready_note     TEXT,

  properties_label TEXT,                    -- 'iConic RR · Downtown · Sidney · Float'

  cap_ac          tech_cap NOT NULL DEFAULT 'no',
  cap_electrical  tech_cap NOT NULL DEFAULT 'no',
  cap_plumbing    tech_cap NOT NULL DEFAULT 'no',
  cap_pool        tech_cap NOT NULL DEFAULT 'no',
  cap_welding     tech_cap NOT NULL DEFAULT 'no',
  cap_painting    tech_cap NOT NULL DEFAULT 'no',
  cap_resurfacing tech_cap NOT NULL DEFAULT 'no',
  cap_cleaning    tech_cap NOT NULL DEFAULT 'na',

  notes      TEXT,
  sort_order INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS technicians_aliases_idx ON technicians USING GIN (appfolio_aliases);
CREATE INDEX IF NOT EXISTS technicians_active_idx  ON technicians (active, sort_order);

CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS technicians_touch ON technicians;
CREATE TRIGGER technicians_touch
  BEFORE UPDATE ON technicians
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- The dashboard connects with the service_role key, which bypasses RLS.
-- Enabling it with no policies means nothing else can reach this table.
ALTER TABLE technicians ENABLE ROW LEVEL SECURITY;

-- ── Seed ─────────────────────────────────────────────────────────────────────
-- 13 people. Jesus and Jorge appeared only as Make Ready chips, with no
-- AppFolio activity and no capabilities row, and are treated as departed —
-- add them here if that turns out to be wrong.
INSERT INTO technicians
  (id, full_name, position, appfolio_aliases, expect_daily_hours,
   show_on_map, home_zip, home_lat, home_lng,
   shows_in_make_ready, make_ready_note, properties_label,
   cap_ac, cap_electrical, cap_plumbing, cap_pool,
   cap_welding, cap_painting, cap_resurfacing, cap_cleaning, sort_order, notes)
VALUES
 ('josue-garcia','Josue Garcia','field_supervisor','{"Josue Garcia C"}',FALSE,
   FALSE,NULL,NULL,NULL, FALSE,NULL,'Floating',
   'yes','highest','yes','yes','yes','yes','no','na',10,
   'Field Supervisor, floating — no fixed property, so the daily-hours alert does not apply.'),

 ('raul-martinez','Raul Martinez','senior_maint_tech','{"Raul Martinez"}',TRUE,
   TRUE,'78724',30.2835,-97.6545, FALSE,NULL,'iConic RR · Downtown · Sidney · Float',
   'highest','yes','yes','yes','no','no','na','na',20,NULL),

 ('jose-renteria','José Rentería','senior_maint_tech','{"Jose Renteria E"}',TRUE,
   TRUE,'78723',30.2972,-97.6859, FALSE,NULL,NULL,
   'na','na','na','na','na','na','na','na',30,
   'Capabilities never filled in — was on the map and roster but missing from the HTML table.'),

 ('angel-martinez','Angel Martinez','maint_tech','{"Angel Martinez C"}',TRUE,
   TRUE,'78754',30.3420,-97.6590, FALSE,NULL,'Hyde Park · Highlander · Chateau',
   'yes','minor','highest','yes','no','yes','no','na',40,NULL),

 ('emerson-garcia','Emerson Garcia','maint_tech','{"Emerson  Garcia -","Emerson Garcia"}',TRUE,
   TRUE,'78753',30.3827,-97.6854, FALSE,NULL,'Ascent · Sunset · Float',
   'yes','minor','yes','yes','yes','yes','yes','na',50,NULL),

 ('carlos-portilla','Carlos Portilla','maint_tech','{"Carlos Portilla"}',TRUE,
   TRUE,'78664',30.5212,-97.6539, FALSE,NULL,'Windy Hill',
   'no','minor','yes','yes','no','na','no','na',60,NULL),

 ('yeison-salgado','Yeison Salgado','maint_tech','{"Yeison Salgado"}',FALSE,
   FALSE,NULL,NULL,NULL, FALSE,NULL,NULL,
   'na','na','na','na','na','na','na','na',70,
   'Logs labor in AppFolio but appeared in none of the five legacy lists. Erick to confirm role and whether the daily-hours alert should apply.'),

 ('fredy-ramirez','Fredy Ramirez','make_ready','{"Fredy Ramirez"}',TRUE,
   FALSE,NULL,NULL,NULL, TRUE,NULL,'Float · Grnds: Sunset/Highlander/Chateau',
   'no','no','no','yes','no','yes','yes','na',80,NULL),

 ('andres-luevano','Andres Luevano','make_ready','{"Andres  Luevano C","Andres Luevano"}',FALSE,
   FALSE,NULL,NULL,NULL, TRUE,NULL,'Float · Grnds: HP/Sidney/RR/Downtown',
   'no','no','no','yes','no','yes','no','na',90,NULL),

 ('franklin-garcia','Franklin Garcia','make_ready','{"Franklin Garcia -","Fran Garcia"}',FALSE,
   FALSE,NULL,NULL,NULL, TRUE,NULL,'Float as needed',
   'no','minor','no','yes','no','yes','maybe','yes',100,
   'The "Franklin" chip and the "Fran Garcia" capabilities row are the same person.'),

 ('rene-hernandez','Rene Hernandez','make_ready','{"Rene Hernandez"}',FALSE,
   FALSE,NULL,NULL,NULL, TRUE,NULL,'Floating',
   'no','minor','no','yes','no','yes','maybe','yes',110,
   'Surname confirmed from AppFolio labor rows; the HTML said "last name pending" and the chip read "Renie".'),

 ('maydelin-gonzalez','Maydelin Gonzalez','housekeeper','{"Maydelin Gonzales C"}',FALSE,
   FALSE,NULL,NULL,NULL, TRUE,'Cleaning — after MR completes','Floating',
   'no','no','no','no','no','yes','no','yes',120,
   'Chip read "Maidelyn"; AppFolio spells the surname "Gonzales".'),

 ('enma-gonzales','Enma Gonzales','other','{"Enma  Gonzales (Hidden)","Enma"}',FALSE,
   FALSE,NULL,NULL,NULL, FALSE,NULL,'Floating',
   'na','na','na','na','na','na','na','yes',130,
   'Marked Hidden in AppFolio and had no position in the capabilities table.')
ON CONFLICT (id) DO NOTHING;
