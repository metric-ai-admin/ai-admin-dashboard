-- 049_sop_review_slab_url.sql
--
-- SOP Review Tracker: store a Slab article URL per SOP so the tracker can link
-- straight to it ("Open in Slab ↗") and admins can edit it inline.
-- This is the sop_review table (Lyndsay's tracker) — NOT the file-based `sops`
-- knowledge base, which is left untouched.
--
-- Idempotent. Run in the Supabase SQL editor.

alter table sop_review add column if not exists slab_url text;
