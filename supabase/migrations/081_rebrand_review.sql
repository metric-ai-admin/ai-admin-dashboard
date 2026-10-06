-- 081_rebrand_review.sql
--
-- Storage for the Metric Rebrand Leadership Review.
--
-- The shape is the page's own: it documents "a single table with columns
-- (path text primary key, data jsonb)" and stores records under
-- "collection/id" — reviews/signal--zach, ideas/<id>, rankings/<person>,
-- final/<person>. Matching it means the page's REMOTE stub is filled in rather
-- than its logic rewritten, so nothing about the content or the design moves.
--
-- WHO AND WHEN are added on top, because the review view has to say "Kara,
-- 2:14 PM" beside an answer and the path alone cannot. updated_by is the
-- person the TOKEN identifies, never anything the browser sends: a reviewer
-- who edits the request body must not be able to sign somebody else's name to
-- an answer.

create table if not exists rebrand_review (
  path        text primary key,
  data        jsonb not null default '{}'::jsonb,
  updated_by  text,
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create index if not exists rebrand_review_updated_idx on rebrand_review (updated_at desc);
create index if not exists rebrand_review_by_idx on rebrand_review (updated_by, updated_at desc);

-- Everything each person wrote, newest edit first:
--
--   select path, updated_by, updated_at, data
--     from rebrand_review order by updated_at desc;
--
-- To undo: drop table rebrand_review;
--
-- NOT PUBLIC. The table is reached only through the server, which checks a
-- per-person token first. There is no anon-key path to it, and RLS is not what
-- is holding the door — the route is.
