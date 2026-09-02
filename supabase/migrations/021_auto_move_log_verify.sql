-- 021_auto_move_log_verify.sql
--
-- Move verification for the Auto-Move engine.
--
-- Graph reissues a message id on move, so auto_move_log.email_id is the id as it
-- was BEFORE the move. These two columns record the RESULT of the move:
--   moved_email_id — the new id Graph returned in the destination folder
--   verified       — true  = the move response's parentFolderId matched the
--                            intended destination (positively confirmed)
--                    false = it landed somewhere else (logged as an error too)
--                    null  = could not be determined (e.g. Graph returned no
--                            parentFolderId) — treated as a non-failing unknown,
--                            not a confirmed success
--
-- Nullable and no default: existing rows stay NULL (unknown), which reads
-- correctly as "logged before verification existed". Idempotent — run in the
-- Supabase SQL editor.

alter table auto_move_log add column if not exists moved_email_id text;
alter table auto_move_log add column if not exists verified       boolean;
