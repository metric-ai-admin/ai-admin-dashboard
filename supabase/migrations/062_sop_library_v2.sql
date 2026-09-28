-- 062_sop_library_v2.sql
--
-- SOP Library v2 — the tables. No data is imported by this migration.
--
-- WHY NOT EXTEND sop_review. That table (024a) carries `proposed_title`,
-- `merge_pair_id`, `merge_decision` and `recommendation_status`: the working
-- state of a one-off cleanup project, not a library. It also has an integer
-- primary key, no department, no access control, no review schedule and no
-- version history. Bending it into v2 would leave every future reader working
-- out which columns are the library and which are archaeology.
--
-- sop_review IS NOT TOUCHED BY THIS MIGRATION and is not dropped later. It
-- holds Lyndsay's and Jay's review decisions on 89 records, and those are
-- exactly the kind of judgement an import must never overwrite. The 89 are
-- COPIED into sop_documents by the importer, with legacy_sop_review_id pointing
-- back at the original.
--
-- WHAT THE SOURCE DATA ACTUALLY IS (measured from the 2026-09-11 Slab export,
-- not assumed): 708 markdown files with NO frontmatter — no title, no author,
-- no dates, no post id. Title comes from the filename and topic from the folder
-- path; nothing else survives the export. 258 of the files are byte-identical
-- copies of another (Slab lets one post sit in several topics and the export
-- writes it once per location), and 44 are empty, so ~450 real documents.
--
-- Idempotent throughout; the Supabase SQL editor ignores BEGIN/COMMIT, so each
-- statement guards itself. Run in the Supabase SQL editor.

-- ── Departments and who may read or edit them ──────────────────────────────
-- A TABLE, not an enum or a hard-coded list: adding a department, or letting
-- Collections read Accounting's procedures, is then a row change rather than a
-- deploy. admin is granted everywhere below; the server also treats admin as
-- able to edit anything, so this table is about everyone else.
create table if not exists sop_departments (
  name        text primary key,
  read_roles  text[] not null default '{}',
  edit_roles  text[] not null default '{}',
  sort_order  integer not null default 0
);

-- Seeded from the ACTUAL roles in dashboard_users as of 2026-09-28:
--   admin · regional_director · maintenance · accounting · collections_leasing
--   leasing_bd · bd_agent · resident_success · evictions_agent
-- Read access is deliberately broad — a procedure nobody can find is a
-- procedure nobody follows — and edit access is deliberately narrow.
-- ON CONFLICT DO NOTHING so re-running never clobbers access somebody has
-- since adjusted by hand.
insert into sop_departments (name, read_roles, edit_roles, sort_order) values
  ('Operations',           array['admin','regional_director','maintenance','accounting','collections_leasing','leasing_bd','bd_agent','resident_success','evictions_agent'], array['admin','regional_director'], 1),
  ('Maintenance',          array['admin','regional_director','maintenance','resident_success'],                                                                            array['admin','maintenance'],        2),
  ('Leasing',              array['admin','regional_director','leasing_bd','bd_agent','collections_leasing','resident_success'],                                            array['admin','leasing_bd'],         3),
  ('Collections',          array['admin','regional_director','collections_leasing','evictions_agent','accounting'],                                                        array['admin','collections_leasing'], 4),
  ('Accounting',           array['admin','regional_director','accounting'],                                                                                                array['admin','accounting'],         5),
  ('Business Development', array['admin','regional_director','bd_agent','leasing_bd'],                                                                                     array['admin','bd_agent'],           6),
  -- HR carries pay, discipline and personal matters. Read is NOT broad here,
  -- and that is the one department where the default should stay closed until
  -- somebody deliberately opens it.
  ('Human Resources',      array['admin','regional_director'],                                                                                                             array['admin'],                      7)
on conflict (name) do nothing;

-- ── The article ────────────────────────────────────────────────────────────
create table if not exists sop_documents (
  id             uuid primary key default gen_random_uuid(),
  -- Stable, readable, and what a URL will carry. Unique so a second import of
  -- the same article updates rather than duplicating.
  slug           text not null unique,
  title          text not null,
  body_md        text not null default '',

  -- Does double duty, which is why it is here rather than computed on demand:
  -- it de-duplicates the import (450 documents out of 708 files), and it
  -- answers "has this changed since it was last reviewed" — without it a
  -- review date only records that somebody opened the page.
  content_hash   text,

  -- Operations | Maintenance | Leasing | Collections | Accounting |
  -- Business Development | Human Resources. Seeded below, and a foreign key so
  -- a typo cannot invent an eighth department nobody has granted access to.
  department     text not null references sop_departments(name),
  category       text,                     -- the Slab sub-folder, e.g. "Accounts Receivable"
  tags           text[] not null default '{}',

  -- Current | Needs Review | Outdated | Archived.
  status         text not null default 'Current',

  -- ── Review schedule ──
  -- NULL means "never scheduled", which is not the same as "reviewed today".
  -- next_review_at is stored rather than derived so a reviewer can push a
  -- single document out without changing everything on that interval.
  review_interval_days integer check (review_interval_days is null or review_interval_days > 0),
  last_reviewed_at     timestamptz,
  last_reviewed_by     text,
  next_review_at       date,

  author         text,                     -- who wrote it, where known
  owner          text,                     -- who is ACCOUNTABLE for it being true

  source         text not null default 'manual',   -- slab | sop_review | manual
  source_path    text,                     -- the path inside the ZIP it came from
  -- The 9 documents that exist in both places. Set by the importer; a human
  -- decides which body wins, never the importer.
  legacy_sop_review_id integer,

  archived       boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  updated_by     text
);

create index if not exists sop_documents_department_idx on sop_documents (department);
create index if not exists sop_documents_status_idx     on sop_documents (status);
create index if not exists sop_documents_hash_idx       on sop_documents (content_hash);
create index if not exists sop_documents_archived_idx   on sop_documents (archived);
-- "What is overdue" is the read this library exists to answer.
create index if not exists sop_documents_due_idx
  on sop_documents (next_review_at) where archived = false;

-- ── Version history ────────────────────────────────────────────────────────
-- The WHOLE body per version, not a diff. 450 documents at a 2.3 KB median is
-- a few megabytes; a diff would need a merge algorithm before anyone could read
-- an old version back, which is a lot of machinery for "what did this say in
-- March".
create table if not exists sop_versions (
  id          uuid primary key default gen_random_uuid(),
  document_id uuid not null references sop_documents(id) on delete cascade,
  version     integer not null,
  title       text,
  body_md     text not null,
  changed_by  text,
  changed_at  timestamptz not null default now(),
  note        text,
  unique (document_id, version)
);
create index if not exists sop_versions_doc_idx on sop_versions (document_id, version desc);

-- ── Rehosted images ────────────────────────────────────────────────────────
-- Every one of the 763 images in the export is a static.slab.com URL signed
-- with a JWT that EXPIRES 2027-09-11, and decommissioning Slab may break them
-- sooner. Unrehosted, the library silently loses its screenshots about a year
-- from now, which is the worst kind of failure: gradual and unannounced.
--
-- fetch_error is a column rather than a log line on purpose. A failed image is
-- a hole in a procedure somebody is following, and it has to be findable.
create table if not exists sop_assets (
  id            uuid primary key default gen_random_uuid(),
  document_id   uuid references sop_documents(id) on delete cascade,
  original_url  text not null,
  stored_path   text,                      -- relative to DATA_DIR/sop-assets/
  content_type  text,
  bytes         integer,
  fetched_at    timestamptz,
  fetch_error   text,
  unique (document_id, original_url)
);
create index if not exists sop_assets_failed_idx on sop_assets (document_id) where fetch_error is not null;

-- ── Review scheduling helper ───────────────────────────────────────────────
-- Kept in SQL so the dashboard, a cron and a person running a query all agree
-- on what "overdue" means. A document with no interval is never overdue —
-- unscheduled is a real state, not a silent failure to review.
create or replace view sop_documents_due as
  select d.*,
         (d.next_review_at is not null and d.next_review_at < current_date) as overdue,
         (d.next_review_at is not null and d.next_review_at >= current_date
            and d.next_review_at <= current_date + 14)                      as due_soon
    from sop_documents d
   where d.archived = false;

-- Verify:
--   select count(*) from sop_documents;                       -- 0 until the importer runs
--   select name, array_length(read_roles,1), array_length(edit_roles,1) from sop_departments order by sort_order;
--   select count(*) from sop_documents_due where overdue;
