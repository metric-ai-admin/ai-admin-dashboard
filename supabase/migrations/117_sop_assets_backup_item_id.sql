-- Where the SharePoint second copy of each SOP image went.
--
-- WHY. The 501 rescued images are the only copy of every screenshot in the
-- SOP library, on one Render disk. scripts/backup-sop-assets-sharepoint.js
-- copies them to a TEAM SITE, and these columns are what make that copy
-- findable and re-runnable.
--
-- backup_item_id IS THE READ HANDLE, not a link. A webUrl is a browser URL
-- into somebody's permissions; /drives/{drive}/items/{item}/content is an
-- address the server can call with its own credentials. This is the whole
-- lesson of migration 116, applied before it costs anything this time.
--
-- backup_bytes IS THE VERIFICATION. The backup script compares it to the file
-- on disk and re-uploads when they disagree. Without it a truncated upload is
-- indistinguishable from a good one, and a re-run would skip it forever.
--
-- backup_path IS NOT THE HANDLE. It is recorded so a human can find the file
-- in SharePoint and so a failed run can be read afterwards; the id survives a
-- move or a rename and the path does not. Readers use the id.
--
-- NOTHING HERE CHANGES WHAT IS SERVED. /api/sop/assets keeps reading the disk.
-- The disk stays primary; this records a copy, not a replacement.
--
-- NOT BACKFILLED. Nothing is backed up until the script runs with --write
-- against the folder Jay picks, so every row starts NULL and that is correct:
-- NULL means "no second copy", which is exactly true today.
--
-- NO NEW GRANTS. The 2026-10-30 rule is about tables created in `public` with
-- no explicit grant; columns added to an existing table inherit what the table
-- already has. sop_assets was granted in 062.

alter table sop_assets add column if not exists backup_item_id  text;
alter table sop_assets add column if not exists backup_bytes    bigint;
alter table sop_assets add column if not exists backup_drive_id text;
alter table sop_assets add column if not exists backup_path     text;
alter table sop_assets add column if not exists backup_at       timestamptz;

comment on column sop_assets.backup_item_id is
  'Graph driveItem id of the SharePoint team-site copy, from the verified '
  'upload response. NULL means there is no second copy of this image. The '
  'disk under DATA_DIR/sop-assets remains the primary and is what '
  '/api/sop/assets serves.';

comment on column sop_assets.backup_bytes is
  'Size SharePoint reported for the stored copy. The backup script re-uploads '
  'when this disagrees with the file on disk, so a truncated copy cannot be '
  'skipped as if it were done.';

-- How many images still have no second copy:
--   select count(*) from sop_assets
--    where stored_path is not null and fetch_error is null
--      and backup_item_id is null;
