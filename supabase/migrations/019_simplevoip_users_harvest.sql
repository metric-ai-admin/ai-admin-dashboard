-- SimpleVOIP roster — users recovered via the incidental ring-group harvest
--
-- The SmartPBX API key (Kazoo) is unavailable, so the users-list endpoint
-- (/accounts/{id}/users) stays 401-gated. Instead these ids surfaced from the
-- answered_elsewhere_user_ids/_names fields on the call records of the 5
-- original roster members over a 90-day read — no access to anyone else's
-- calls was used, only authorized reads of roster members' own records.
--
-- Adds the 5 cleanly-named new users. ON CONFLICT (user_id) makes it safe to
-- re-run and safe alongside the migration-014 seed.
--
-- NOT added here, on purpose (see report):
--   • f2c9d66624d8f60fefb20f68f395f362 — a SECOND id also labeled "Sammy Ramos".
--     The unique index on lower(name) would reject a duplicate, and we cannot
--     tell if it is a second line/device for the same person or a different
--     user. Pending SimpleVOIP support / a human to disambiguate.
--   • 1ce0954b75e6c7b2f3bfd21ddcd90b33 — appeared with NO name in the ring-group
--     data. name is NOT NULL, so it cannot be inserted until support supplies
--     the name.
--
-- Run in the Supabase SQL editor.

insert into simplevoip_users (name, user_id, role) values
  ('Erick Frey',      'f5b96f763c4a5aadc00d0562d452fe9d', null),
  ('Roxanne De Vero', 'f62b8e7cdaca807ed519b0303f0f8d3d', null),
  ('Sammy Ramos',     'f4218ec50f0edb08f3d6c858c9810122', null),
  ('Yeni Metric',     '77c8318198201c0efea6fb39ab5508fd', null),
  ('Karla Metric',    '07d01fcab2e11d62bcbc8ebc92a93381', null)
on conflict (user_id) do nothing;

-- Check — should be 10 rows after this (5 from migration 014 + 5 here):
-- select name, user_id, active from simplevoip_users order by name;
