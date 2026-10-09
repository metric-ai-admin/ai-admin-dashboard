// Public, read-only SOP links for the maintenance technicians.
//
// They have no dashboard account and are not getting one: the token IS the
// door, exactly as in the Rebrand review. Same shape, with one deliberate
// difference — ONE TOKEN FOR THE GROUP, not one per person. Nobody writes
// anything here, so a per-person token would buy administration and no
// safety, and the techs share phones. Rotating SOP_PUBLIC_SECRET revokes
// every link at once, which is what is wanted when somebody leaves or a link
// lands in a WhatsApp group.
//
// A WRONG TOKEN IS A 404, never a 401. A 401 confirms the URL shape was right
// and invites a second attempt.
//
// WHAT THE QUERY RETURNS IS DECIDED HERE AND NOWHERE ELSE. There is no
// parameter a visitor can set: not a department, not a status, not a search.
// Accounting, HR, Business Development and archived documents are not hidden
// from the page — the query never fetches them.

'use strict';

const crypto = require('crypto');

const GROUP = 'maintenance-techs';
const DEPARTMENT = 'Maintenance';

// WHICH STATUSES ARE PUBLISHED — and why this is not just 'Current'.
//
// Measured against the live table on 2026-10-09: all 59 SOPs with status
// 'Current' are in Operations. Maintenance has 33 documents and EVERY ONE of
// them is 'Needs Review' — they came in together on 2026-09-28 and nobody has
// signed them off since. A page filtered to Maintenance + Current would have
// been empty, and Erick would have been sent a working link to nothing.
//
// So both are published and each card SAYS which it is, rather than shipping
// an empty page or quietly implying that an unreviewed document is approved.
// The moment somebody marks the Maintenance SOPs Current, dropping
// 'Needs Review' from this array is the whole change.
const PUBLISHED_STATUSES = ['Current', 'Needs Review'];

// The columns the page renders, and only those. body_md is the document;
// content_hash, source_path, legacy ids and updated_by are internal and never
// leave the server.
const LIST_COLUMNS = 'slug,title,category,status,updated_at,last_reviewed_at,title_es,es_source_hash';
const DOC_COLUMNS = 'slug,title,category,status,updated_at,last_reviewed_at,body_md,title_es,body_es,es_source_hash,translated_at';

function token(secret) {
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update(GROUP).digest('hex').slice(0, 32);
}

// Constant-time, and length-checked first so a malformed token costs nothing.
// A plain === leaks how much of a guess was right.
function isValidToken(candidate, secret) {
  const t = String(candidate || '');
  if (!/^[0-9a-f]{32}$/.test(t)) return false;
  const expected = token(secret);
  if (!expected) return false;
  const a = Buffer.from(expected), b = Buffer.from(t);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// A slug off the URL. Anything that is not a slug is not looked up: the column
// is indexed text and a free-form value is a query somebody else wrote.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,120}$/;
const isSlug = s => SLUG_RE.test(String(s || ''));

// The one filter, applied server-side to every read. Taking a PostgREST
// builder and returning it narrowed, so there is exactly one place that
// decides what is public.
function scope(query) {
  return query.eq('department', DEPARTMENT).eq('archived', false).in('status', PUBLISHED_STATUSES);
}

// Grouped for the index, in the order a technician reads them: by category,
// then by title. Not by date — a SOP revised yesterday is not more important
// than the one above it.
// The index needs to know, per SOP, whether a Spanish title can be shown. It
// cannot run the full staleness test without the bodies — and pulling 33
// bodies to render a list of titles is the wrong trade — so it reports what it
// has and the document page makes the final call when it loads the body.
const T = require('./sop-translate.js');

function groupForIndex(rows) {
  const by = new Map();
  (rows || []).forEach(r => {
    const cat = String(r.category || 'General').trim() || 'General';
    if (!by.has(cat)) by.set(cat, []);
    by.get(cat).push({
      slug: r.slug,
      title: r.title || r.slug,
      // Null when there is no Spanish title at all, so the index can fall back
      // per SOP instead of switching the whole page back to English.
      title_es: r.title_es || null,
      status: r.status || null,
      updated: String(r.updated_at || '').slice(0, 10) || null,
      reviewed: String(r.last_reviewed_at || '').slice(0, 10) || null,
    });
  });
  return [...by.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([category, sops]) => ({
      category,
      sops: sops.sort((a, b) => String(a.title).localeCompare(String(b.title))),
    }));
}

// What the document page is sent: both languages and the verdict, worked out
// on the SERVER. The page renders; it does not decide what is current.
function docPayload(row) {
  return {
    slug: row.slug,
    category: row.category || null,
    status: row.status || null,
    updated_at: row.updated_at || null,
    last_reviewed_at: row.last_reviewed_at || null,
    en: { title: row.title || row.slug, body: row.body_md || '' },
    es: T.translationState(row) === 'ok'
      ? { title: row.title_es, body: row.body_es }
      : null,
    translationState: T.translationState(row),
    translated_at: row.translated_at || null,
  };
}

module.exports = {
  GROUP, DEPARTMENT, PUBLISHED_STATUSES, LIST_COLUMNS, DOC_COLUMNS,
  token, isValidToken, isSlug, scope, groupForIndex, docPayload,
};
