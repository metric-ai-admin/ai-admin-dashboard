-- 024a_sop_review_table.sql
--
-- Lyndsay's SOP Review Tracker — table only. Run this FIRST, then run
-- 024b_sop_review_seed.sql to load the 89 records. SEPARATE from the file-based
-- 'sops' knowledge base (/api/sops) — that table is not touched.
-- Idempotent. Run in the Supabase SQL editor.

create table if not exists sop_review (
  id                      integer primary key,
  file                    text,
  title                   text,
  proposed_title          text,
  title_status            text,
  original_title          text,
  category                text,
  tags                    jsonb,
  status                  text,
  resman                  text,
  merge                   text,
  merge_pair_id           integer,
  merge_decision          text,
  full_text               text,
  recommendation          text,
  recommendation_status   text,
  original_recommendation text,
  source_note             text,
  pending                 boolean default false,
  archived                boolean default false,
  previous_status         text,
  screenshots             jsonb default '[]'::jsonb,
  updated_at              timestamptz default now(),
  updated_by              text
);
create index if not exists sop_review_category_idx on sop_review (category);
create index if not exists sop_review_status_idx   on sop_review (status);
