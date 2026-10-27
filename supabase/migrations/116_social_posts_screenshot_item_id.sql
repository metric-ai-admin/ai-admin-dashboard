-- The Graph item id of a post's screenshot, so the file can be READ back.
--
-- WHY. socialUploadScreenshot stores Graph's `webUrl` and nothing else. That
-- URL is a permissions object in admin@metricpropertymanagement.com's PERSONAL
-- OneDrive (netorgft5473895-my.sharepoint.com), so everybody except admin@
-- opens it and gets "You need access" — seen on Daria's 10/27 post, and true
-- of every screenshot ever stored. The fix is to stream the bytes through the
-- app's own credentials instead of sending people to SharePoint, and for that
-- the server needs a handle it can actually call.
--
-- A webUrl is not that handle: it is a browser link, not an API address.
-- `/users/{owner}/drive/items/{id}/content` is. The upload's PUT response has
-- carried `j.id` all along and we have been discarding it.
--
-- WHY NOT JUST REBUILD THE PATH. The route falls back to
-- SOCIAL_FOLDER/weekFolder(created_at)/screenshot_name for the rows that
-- predate this column, and that fallback works — but it re-derives the folder
-- from a date rather than reading where the file actually went, and it breaks
-- the moment anybody moves or renames a file in SharePoint. The id survives
-- both. So: id for new rows, path for old ones, and no backfill.
--
-- NOT BACKFILLED ON PURPOSE. Filling this in would mean a Graph call per
-- existing row, from a migration, against production — for rows the path
-- fallback already serves. If those rows ever need it, a script can do it
-- deliberately and report what it found.
--
-- NO NEW GRANTS. The 2026-10-30 rule is about tables created in `public` with
-- no explicit grant; a column added to an existing table inherits what the
-- table already has. social_posts was granted in 108.

alter table social_posts add column if not exists screenshot_item_id text;

comment on column social_posts.screenshot_item_id is
  'Graph driveItem id of the screenshot, from the upload response. Read by '
  'GET /api/social-posts/:id/screenshot, which streams the file with the app '
  'credentials. NULL on rows uploaded before 2026-10-27; those fall back to '
  'the reconstructed SharePoint path. Nothing shares the OneDrive folder.';

-- No index. The column is only ever read by id on a row already fetched by
-- its primary key — never filtered or joined on — so an index here would be a
-- write cost with no reader.
