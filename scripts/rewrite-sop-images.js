#!/usr/bin/env node
//
// Point the imported SOPs at the rehosted images instead of at Slab.
//
//   node scripts/rewrite-sop-images.js --dry-run
//   node scripts/rewrite-sop-images.js
//
// RUN THIS AFTER THE IMAGES ARE ON THE SERVER'S DISK, not before. Until the
// files exist under DATA_DIR/sop-assets the articles still render against
// Slab's own URLs, which work until 2027-09-11 — so a document with a live
// image is strictly better than a document pointing at a file that is not
// there yet. Rewriting early would break 200 articles to fix them later.
//
// It rewrites to `sop-assets/<file>`, NOT to a full /api/sop/assets/ path.
// sop-library.js's renderer resolves that prefix to the serving route, so the
// stored markdown stays portable: if the route ever moves, one function changes
// rather than 411 documents.
//
// SAFE TO RE-RUN. A document already rewritten has no Slab image URLs left to
// match, so a second pass is a no-op. An image with no row in sop_assets is
// LEFT ALONE and reported — a broken link that still points at Slab can be
// recovered; one pointing at a file that was never fetched cannot.

require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const DRY = process.argv.includes('--dry-run');
const KNOWN = ['--dry-run'];
const unknown = process.argv.slice(2).filter(a => a.startsWith('--') && !KNOWN.includes(a));
if (unknown.length) { console.error('Unknown flag(s): ' + unknown.join(', ')); process.exit(2); }

const IMG_RE = /(!\[[^\]]*\]\()(https?:\/\/[^)\s]+)(\))/g;
const canonical = u => String(u).split('?')[0];
const hash = t => crypto.createHash('sha1').update(String(t || '').trim()).digest('hex');

(async () => {
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY);

  const assets = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await db.from('sop_assets')
      .select('canonical_url,original_url,stored_path').range(from, from + 499);
    if (error) throw new Error('sop_assets: ' + error.message);
    assets.push(...(data || []));
    if (!data || data.length < 500) break;
  }
  // Only images that were actually FETCHED can be pointed at. A row with a
  // fetch_error has no file behind it.
  const byUrl = new Map();
  assets.filter(a => a.stored_path).forEach(a => {
    byUrl.set(a.canonical_url || canonical(a.original_url), a.stored_path);
  });
  console.log(`sop_assets: ${assets.length} rows, ${byUrl.size} with a stored file`);

  const docs = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await db.from('sop_documents')
      .select('id,title,body_md,source,updated_by').range(from, from + 499);
    if (error) throw new Error('sop_documents: ' + error.message);
    docs.push(...(data || []));
    if (!data || data.length < 500) break;
  }
  console.log(`sop_documents: ${docs.length} rows\n`);

  let changedDocs = 0, rewritten = 0, unresolved = 0, alreadyLocal = 0;
  const missing = new Map();
  const updates = [];

  for (const d of docs) {
    const body = String(d.body_md || '');
    if (!body) continue;
    let touched = 0;
    const next = body.replace(IMG_RE, (whole, open, url, close) => {
      if (/^sop-assets\//.test(url) || /^\/api\/sop\/assets\//.test(url)) { alreadyLocal++; return whole; }
      const stored = byUrl.get(canonical(url));
      if (!stored) {
        unresolved++;
        const k = canonical(url);
        missing.set(k, (missing.get(k) || 0) + 1);
        return whole;                       // left pointing at Slab, on purpose
      }
      touched++;
      return open + stored + close;
    });
    if (touched) {
      changedDocs++; rewritten += touched;
      // content_hash follows the body it describes, or "has this changed since
      // it was reviewed" starts lying the moment the images move.
      updates.push({ id: d.id, body_md: next, content_hash: hash(next), title: d.title });
    }
  }

  console.log('PLAN');
  console.log(`  documents to change   : ${changedDocs}`);
  console.log(`  image links rewritten : ${rewritten}`);
  console.log(`  already local         : ${alreadyLocal}`);
  console.log(`  could not resolve     : ${unresolved}${missing.size ? `  (${missing.size} distinct URLs)` : ''}`);
  if (missing.size) {
    console.log('\n  These have no fetched file and are LEFT pointing at Slab:');
    [...missing.entries()].slice(0, 10).forEach(([u, n]) => console.log(`    ${n}x  ${u.slice(0, 96)}`));
    if (missing.size > 10) console.log(`    … and ${missing.size - 10} more`);
    console.log('  Run the fetcher again before rewriting if these matter.');
  }

  if (DRY) {
    console.log('\n--dry-run: nothing written.');
    updates.slice(0, 5).forEach(u => console.log(`  ${u.title.slice(0, 60)}`));
    return;
  }
  if (!updates.length) { console.log('\nnothing to rewrite.'); return; }

  let done = 0;
  for (const u of updates) {
    const { id, title, ...patch } = u;
    const { error } = await db.from('sop_documents').update(patch).eq('id', id);
    if (error) throw new Error(`update ${id} (${title}): ${error.message}`);
    done++;
    if (done % 25 === 0 || done === updates.length) process.stdout.write(`\r  updated ${done}/${updates.length}`);
  }
  console.log(`\n\nrewrote ${rewritten} image links across ${done} documents.`);
  console.log('Images now serve from /api/sop/assets/ — check one in the dashboard before closing this out.');
})().catch(e => { console.error('\nfailed:', e.message); process.exitCode = 1; });
