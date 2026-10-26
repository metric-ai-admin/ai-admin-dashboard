-- Who uploaded a post, as distinct from whose post it is.
--
-- Jay, 2026-10-26: the leasing agents stop uploading their own links. Katie
-- chases them in the WhatsApp group and Katrina enters the links into the tool
-- on their behalf.
--
-- So `author` stops meaning "the person who pressed the button". It keeps
-- meaning "whose post this is" — which is what the daily check counts, what
-- the duplicate message names, and what Rocío's own-posts-only view filters
-- on. All three keep working untouched because the author is still the agent.
--
-- What had nowhere to go was Katrina. These two columns are that record: who
-- actually did the entering. Set on EVERY post, including a self-upload, so
-- "who touched the system" has one answer everywhere rather than a null that
-- has to be read as "the same person, probably".
--
-- NO NEW GRANTS. The 2026-10-30 rule is about tables created in `public` with
-- no explicit grant; columns added to an existing table inherit what the table
-- already has. social_posts was granted in 108.

alter table social_posts add column if not exists uploaded_by       text;
alter table social_posts add column if not exists uploaded_by_email text;

comment on column social_posts.uploaded_by is
  'Who entered the post into the tool. Differs from author when somebody uploads on an agent''s behalf (Katrina for the leasing agents, from 2026-10-26).';
comment on column social_posts.uploaded_by_email is
  'The login that entered the post. The author_email stays the agent''s, so the daily check and the own-posts-only scoping are unaffected.';

-- Backfill: every row so far was entered by its own author, so the record is
-- true rather than merely blank. Only touches rows where it has not been set,
-- so re-running this changes nothing.
update social_posts
   set uploaded_by       = author,
       uploaded_by_email = author_email
 where uploaded_by is null;

-- The day's list shows the uploader only when it differs from the author, and
-- that comparison runs per row. Nothing queries BY uploader yet, so there is
-- no index here on purpose: an index nobody reads is a write cost with no
-- reader. Add one when something groups by it.
