-- 108 — social media post links, one row per post.
--
-- Lyndsay, via the "Social Media Links" group: a tool for uploading the
-- links, no duplicates, screenshots kept for the weekly report, and a daily
-- accountability check.
--
-- Today an agent publishes on their own Facebook, TikTok or Nextdoor page,
-- sends the link to a WhatsApp group, Katrina checks it is not a repeat, and
-- Katie copies it into a workbook. This replaces the WhatsApp step and
-- Katrina's eyeballing; Katie's workbook is NOT touched, and Jay's tracker
-- will read this table instead of parsing it.

create table if not exists social_posts (
  id              uuid primary key default gen_random_uuid(),

  -- The link exactly as the agent pasted it. This is what somebody clicks to
  -- see the post, and it is never rewritten.
  url             text not null,

  -- The comparable form: host aliased, tracking parameters dropped, query
  -- sorted, fragment gone. The unique index sits HERE, not on `url` — two
  -- people sharing one post from two phones produce different urls.
  normalised_url  text not null,

  platform        text not null,          -- Facebook | TikTok | Nextdoor
  property        text,                   -- canonical name, null if general

  -- Who uploaded it, from the session. Never from the form.
  author          text not null,
  author_email    text,

  -- The day the post was made, if the agent says; otherwise the upload day is
  -- all we know and posted_on stays null rather than claiming to be it.
  posted_on       date,

  -- SharePoint, in a per-week folder. The bytes do not live in Postgres: the
  -- weekly report needs them where people already look.
  screenshot_url  text,
  screenshot_name text,
  -- sha256 of the uploaded bytes. Exact matches are the same screenshot.
  image_hash      text,

  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- NO DUPLICATE LINKS. The first half of what Lyndsay asked for, enforced by
-- the database rather than by whoever is reading the group chat.
create unique index if not exists social_posts_normalised_idx
  on social_posts (normalised_url);

-- Exact-duplicate screenshots. Not unique: the same screenshot can legitimately
-- accompany a correction, and blocking it in the index would leave no way to
-- say so. The check is in code, where it can explain itself.
create index if not exists social_posts_image_idx on social_posts (image_hash);
create index if not exists social_posts_day_idx on social_posts (created_at desc);
create index if not exists social_posts_author_idx on social_posts (author, created_at desc);

comment on table social_posts is
  'Social media posts by agent. One row per post; normalised_url is unique so the same post cannot be filed twice.';
comment on column social_posts.url is
  'As pasted. Never rewritten — it is what proves the post exists.';
comment on column social_posts.posted_on is
  'The day the post was made, when stated. NULL means we only know when it was uploaded, which is a different fact.';

-- ---------------------------------------------------------------------------
-- Who is expected to post, and how often. EMPTY ON PURPOSE.
--
-- Lyndsay has not said how many posts a day are expected or who receives the
-- summary. An empty roster makes the daily check answer "we do not know who
-- was expected" rather than "everybody is up to date", which is the honest
-- reading and the one that will not quietly bless a day nobody posted.
create table if not exists social_post_roster (
  person      text primary key,
  expected    integer not null default 1,
  active      boolean not null default true,
  properties  text,
  updated_at  timestamptz not null default now()
);

comment on table social_post_roster is
  'Who posts and how many times a day. EMPTY until Lyndsay says; the daily check reports "not known" rather than "all clear" while it is.';

-- Verify:
--   select platform, count(*) from social_posts group by 1;
--   select count(*) from social_post_roster;
