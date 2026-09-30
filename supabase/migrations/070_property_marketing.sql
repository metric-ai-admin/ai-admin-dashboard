-- 070_property_marketing.sql
--
-- Marketing Phase 1: the social directory, one row per property.
--
-- WHY IT EXISTS. Nothing in the dashboard held a property website, let alone a
-- Facebook page — checked on 2026-09-30 across property_assignments,
-- leasing_occupancy, the BD CRM properties table (251 rows, none of ours) and
-- every registered AppFolio report. Katrina supplied the eight sites; the
-- social links were read out of their footers.
--
-- WHAT THE FOOTERS ACTUALLY SAID, because it shaped these columns:
--
--   * Facebook is per property — eight distinct pages, except the two iConic
--     properties, which share a site and a page.
--   * TikTok is ONE corporate account, @metricpm, linked from all eight sites.
--     Instagram likewise appears only as the corporate account, and only on the
--     iConic site. Repeating either across eight rows would say there are eight
--     accounts, so they live on a single "(corporate)" row and the property
--     rows leave those columns empty until Katrina finds real ones.
--   * 6448 E Hwy 290 E. Suite A-112 is linked from nearly every site: it is
--     Metric's own office, not the property. It is not stored anywhere here.
--
-- VERIFIED IS PER LINK, not per row. Katrina can confirm a Facebook page and
-- doubt an Instagram, and one flag for the whole row would force a lie about
-- one of them. Everything starts false except the two things confirmed against
-- AppFolio: the websites, and the two iConic Google listings.
--
-- Run in the Supabase SQL editor BEFORE deploying the code that reads it.
-- Idempotent and safe to re-run.

create table if not exists property_marketing (
  -- Keyed on the name, like property_assignments. A new id would need a mapping
  -- no other table in the dashboard uses.
  property     text primary key,

  website      text,
  facebook     text,
  instagram    text,
  tiktok       text,
  google       text,

  website_verified   boolean not null default false,
  facebook_verified  boolean not null default false,
  instagram_verified boolean not null default false,
  tiktok_verified    boolean not null default false,
  google_verified    boolean not null default false,

  -- Shown on the row in the UI. Ascent at Northgate is why this exists: its
  -- site links a Google listing for 1830 W Rundberg Ln while AppFolio and the
  -- bank both have the property at 9315 Northgate Blvd. The link is stored
  -- unverified and the disagreement is stated rather than resolved by guessing.
  note         text,

  verified_by  text,
  verified_at  timestamptz,
  -- 'footer scrape' | 'manual' — where the link came from, so a wrong one can
  -- be traced back to whether a human typed it or a page claimed it.
  source       text,
  updated_by   text,
  updated_at   timestamptz not null default now()
);

create index if not exists property_marketing_updated_idx
  on property_marketing (updated_at desc);

-- If 070 was already run WITHOUT the note column, this brings it up to date and
-- is a no-op otherwise:
alter table property_marketing add column if not exists note text;

-- Verify, after the seed:
--
--   select property, website is not null as has_site, facebook is not null as has_fb,
--          google_verified, note
--     from property_marketing order by property;
--
-- Expect nine rows: the eight managed properties and one "(corporate)".
