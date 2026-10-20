-- 109 — the roster can name a person without inventing their quota.
--
-- Bekah confirmed WHO posts (Rocio, Sammy, Oscar, Yeni, Daria). Lyndsay has
-- not said HOW MANY posts a day are expected. 108 wrote `expected integer not
-- null default 1`, so loading the five names would have silently set everyone's
-- target to one a day and the daily check would start reporting "Oscar is
-- missing" against a number nobody chose.
--
-- That is the same failure this project keeps closing: a value that is not
-- known must not arrive wearing a plausible default. After this migration
-- `expected` is NULL until Lyndsay says, and dailyCheck reads NULL as "the
-- target is not set" — the person is listed with what they posted and is never
-- called missing.
--
-- Idempotent and safe to re-run. Run in the Supabase SQL editor.

alter table social_post_roster alter column expected drop default;
alter table social_post_roster alter column expected drop not null;

-- Existing rows: there are none today (the table was deliberately left empty),
-- but if any exist they carry the 108 default of 1, which is indistinguishable
-- from a real choice. Nothing is rewritten here — a blind update would destroy
-- a number somebody did set. Check before loading:
--
--   select person, expected from social_post_roster;

-- THE LOGIN, NOT THE SPELLING OF A NAME.
--
-- The daily check matches a post's author against the roster. `author` is the
-- session's display name, so "Rocío" in dashboard_users and "Rocio" in the
-- roster are two different people as far as the match is concerned, and the
-- failure is silent: she posts, the count stays zero, and the check reports her
-- missing. The email is the stable key and is already stored on every post.
--
-- Nullable, because four of the five have no account yet. A row with no email
-- still matches by name — which is all we have for them — and the screen says
-- which basis it used rather than implying the match is solid.
alter table social_post_roster add column if not exists email text;

comment on column social_post_roster.expected is
  'Posts expected per day. NULL = not set yet (Lyndsay has not said). NULL is never read as zero and never makes somebody "missing".';
comment on column social_post_roster.email is
  'The dashboard login (@metric.internal). The stable key for matching posts to people; NULL means we can only match on the name.';

-- Verify:
--   select person, email, expected, active from social_post_roster order by person;
--   -- expect expected IS NULL for all five until Lyndsay sets a number
