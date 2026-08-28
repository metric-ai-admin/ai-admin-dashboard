-- SimpleVOIP — user roster
--
-- Replaces the one-env-var-per-person plan. SIMPLEVOIP_USER_ID_ERICK,
-- _RHOXIE, _KATIE and so on would mean a Render redeploy every time someone
-- joins or leaves, and the list would live somewhere nobody thinks to look.
--
-- DDL only, no rows. The ids come from Kazoo and nobody has run that yet:
--   PUT  https://kazoo.simplevoip.us:8443/v2/api_auth  {"data":{"api_key":"…"}}
--   GET  https://kazoo.simplevoip.us:8443/v2/accounts/{account_id}/users
--        header X-Auth-Token: {token}
-- The 64-character API key is at portal.simplevoip.us, Authentication app.
--
-- Until this table has rows the module falls back to SIMPLEVOIP_USER_ID, so
-- Rebekah's calls work the moment that env var is set — no rows required.
--
-- Run in the Supabase SQL editor. Every statement is IF NOT EXISTS and safe to
-- re-run; the editor does not honour BEGIN/COMMIT.

create table if not exists simplevoip_users (
  id      uuid primary key default gen_random_uuid(),
  name    text not null,
  -- The SimpleVOIP/Kazoo user id, a 32-character hex string. Not our
  -- dashboard_users id and not an email: it is what goes in the ajax URL.
  user_id text not null,
  role    text,
  active  boolean not null default true
);

-- One row per SimpleVOIP user. Two rows for the same person would make the
-- selector show them twice and the two entries could drift apart.
create unique index if not exists simplevoip_users_user_id_key
  on simplevoip_users (user_id);

-- Names are how the selector is read and sorted, so the same person cannot be
-- entered twice under different casing.
create unique index if not exists simplevoip_users_name_key
  on simplevoip_users (lower(btrim(name)));

create index if not exists simplevoip_users_active_idx
  on simplevoip_users (active);

-- ---------------------------------------------------------------------------
-- Who may read whose calls is NOT settled. Pending Lyndsay's decision, only
-- admins can change the selector, and the server refuses a user_id from anyone
-- else rather than trusting a hidden dropdown. Transcripts are conversations
-- with residents and between employees; widening this is a decision, not a
-- default.
-- ---------------------------------------------------------------------------

-- Check:
-- select name, role, active, user_id from simplevoip_users order by name;
