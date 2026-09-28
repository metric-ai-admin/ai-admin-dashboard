-- 063_sop_assets_preimport.sql
--
-- Let the image fetcher run BEFORE the Slab ZIP is imported.
--
-- The images have to be rescued on their own clock: the JWTs in their URLs
-- expire 2027-09-11 and Slab is being decommissioned before that. But the ZIP
-- import is blocked on Jay's department mapping, so the fetcher has to record
-- 501 images with NO document to attach them to yet.
--
-- Two things stop that working against 062 as written:
--
--   1. There is nowhere to record WHICH article an image came from, so once
--      the ZIP is imported there would be no way to attach the rescued files
--      short of re-parsing the whole export.
--
--   2. `unique (document_id, original_url)` does not constrain rows where
--      document_id is null — Postgres treats NULLs as distinct — so a second
--      run of a script that is advertised as safe to re-run would insert 501
--      duplicates. A partial unique index is what actually holds there.
--
-- Idempotent. Run in the Supabase SQL editor.

-- Which markdown file inside the export referenced this image. Populated by
-- the fetcher, read by the ZIP importer when it attaches assets to documents.
alter table sop_assets add column if not exists source_path text;

-- The image as it appears in the markdown, with the expiring ?jwt= stripped.
-- The same image is referenced from several articles with different signatures,
-- so this is what "the same image" actually means: 763 references resolve to
-- 501 distinct files.
alter table sop_assets add column if not exists canonical_url text;

-- Makes the pre-import rows re-runnable. Scoped with `where document_id is
-- null` so it cannot collide with the (document_id, original_url) constraint
-- once assets are attached to real documents.
create unique index if not exists sop_assets_unassigned_url_idx
  on sop_assets (canonical_url) where document_id is null;

create index if not exists sop_assets_source_path_idx on sop_assets (source_path);
create index if not exists sop_assets_canonical_idx   on sop_assets (canonical_url);

-- Verify:
--   select count(*) from sop_assets;                              -- 0 before the fetcher runs
--   select count(*) from sop_assets where fetch_error is not null;
--   select count(*) filter (where stored_path is not null) as fetched,
--          count(*) filter (where fetch_error is not null)  as failed
--     from sop_assets;
