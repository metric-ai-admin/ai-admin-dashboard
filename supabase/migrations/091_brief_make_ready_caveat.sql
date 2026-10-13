-- 091 — the make-ready caveat on Kara's brief, switchable without a deploy.
--
-- Jay, 2026-10-13: while Erick cross-checks the vacant units against the
-- technicians, the brief says the make-ready numbers may not be exact yet.
--
-- IT IS BUILT TO BE REMOVED. When the clean-up is done:
--
--   UPDATE brief_thresholds SET make_ready_caveat = '' WHERE property = '*';
--
-- An EMPTY STRING is "off". NULL means "use the built-in default", which is
-- what every existing row has, so running this migration changes nothing on
-- its own. If empty meant "fall back to the default" there would be no way to
-- turn the note off from the table at all, which is the whole point.
--
-- lib/kara-brief.js holds the default text; deleting the constant there
-- removes it for good.

ALTER TABLE brief_thresholds
  ADD COLUMN IF NOT EXISTS make_ready_caveat text;

COMMENT ON COLUMN brief_thresholds.make_ready_caveat IS
  'Read from the ''*'' row only. NULL = use the default in lib/kara-brief.js; empty string = no caveat; any other text replaces it.';
