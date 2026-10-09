-- 084 — Spanish translations for the SOPs the maintenance technicians read.
--
-- NOT RUN YET. Arturo reviews this before it goes near Supabase (2026-10-09).
--
-- Most of the maintenance technicians do not read English, and the public SOP
-- links at /sops/<token> were about to be sent to them. Spanish is the DEFAULT
-- on those pages; English is the fallback and the source of record.
--
-- EVERY COLUMN IS A CACHE OF A TRANSLATION ALREADY MADE. Nothing here is
-- written by a visitor, and the public route never calls an API: a page that
-- could trigger a paid request on a GET is a page anybody can bill us with.
-- scripts/translate-sops.js writes these; the pages only read them.

alter table sop_documents
  -- The translated title and body. NULL means "never translated", which the
  -- page shows as English with a notice rather than as an empty document.
  add column if not exists title_es    text,
  add column if not exists body_es     text,

  -- WHAT WAS TRANSLATED, as a hash of the English title and body at the moment
  -- the translation was made. This is the whole staleness mechanism: if the
  -- English SOP is edited, the hash stops matching and the page falls back to
  -- English with a notice instead of showing a translation of text that no
  -- longer exists. A timestamp could not do this — an edit and a translation
  -- can happen in either order, and "newer" is not the same as "of this text".
  add column if not exists es_source_hash text,

  add column if not exists translated_at  timestamptz,
  -- Which model produced it, so a bad batch can be found and redone without
  -- guessing which ones came from where.
  add column if not exists translated_by  text;

comment on column sop_documents.es_source_hash is
  'sha256 of the English title and body_md at translation time. The Spanish '
  'text is stale when this stops matching the current English, and the public '
  'page then shows English with a notice. Written only by '
  'scripts/translate-sops.js; never by a request.';

comment on column sop_documents.body_es is
  'Machine translation, cached. The public SOP pages read it and never '
  'generate it: a GET that can call a paid API is a GET anybody can bill us '
  'with.';

-- The public page asks for one Maintenance SOP at a time by slug, and the
-- index asks for all of them. Both already filter on department + archived +
-- status; this is the index that serves that filter.
create index if not exists sop_documents_public_idx
  on sop_documents (department, archived, status);

-- Finding what still needs translating, or has gone stale, without reading
-- every body. Partial: the rows that are up to date are the ones nobody asks
-- about.
create index if not exists sop_documents_untranslated_idx
  on sop_documents (department)
  where body_es is null;
