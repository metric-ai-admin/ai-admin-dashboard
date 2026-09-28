#!/usr/bin/env node
//
// Copy the 89 curated SOPs from sop_review into the v2 library.
//
//   node scripts/import-sop-review.js --dry-run
//   node scripts/import-sop-review.js
//
// sop_review IS NOT MODIFIED OR DROPPED. It holds Lyndsay's and Jay's review
// decisions — proposed titles, merge pairings, recommendations — and those are
// exactly the judgements an import must never overwrite. Each new document
// keeps legacy_sop_review_id pointing back at its source row.
//
// Department is 'Operations' for everything, by instruction: Jay reclassifies
// through the UI. That is a deliberate placeholder rather than a guess at seven
// departments' worth of ownership, and it is visible — everything in the
// library will read Operations until somebody moves it.
//
// RE-RUNNABLE. Matched on legacy_sop_review_id, so a second run updates the
// documents it created rather than making 89 more. A document a person has
// since EDITED is left alone: the whole point of the library is that a human
// version outranks an import.

require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const KNOWN = ['--dry-run', '--force'];
const unknown = process.argv.slice(2).filter(a => a.startsWith('--') && !KNOWN.includes(a));
if (unknown.length) {
  console.error('Unknown flag(s): ' + unknown.join(', ') + '\nKnown: ' + KNOWN.join(' '));
  process.exit(2);
}

const DEPARTMENT = 'Operations';

// sop_review's statuses are a cleanup project's vocabulary; the library has
// four. Anything unmapped becomes Needs Review rather than Current, because
// "we could not tell" and "it is fine" are different answers.
const STATUS_MAP = {
  'Keep As-Is': 'Current',
  'Update Needed': 'Needs Review',
  'Pending Review': 'Needs Review',
  'Merge Candidate': 'Needs Review',
  'Awaiting File': 'Needs Review',
  Archive: 'Archived',
};

const slugify = s => String(s || '')
  .toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '')
  .trim().replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 80) || 'untitled';

const hash = s => crypto.createHash('sha1').update(String(s || '').trim()).digest('hex');

(async () => {
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY);

  const { data: rows, error } = await db.from('sop_review').select('*').limit(2000);
  if (error) throw new Error('sop_review: ' + error.message);
  console.log(`sop_review: ${rows.length} rows`);

  const { data: existing, error: exErr } = await db.from('sop_documents')
    .select('id,slug,legacy_sop_review_id,content_hash,updated_by,title');
  if (exErr) {
    if (/does not exist/i.test(exErr.message)) {
      throw new Error('sop_documents does not exist — run supabase/migrations/062_sop_library_v2.sql first.');
    }
    throw new Error(exErr.message);
  }
  const byLegacy = new Map((existing || []).filter(d => d.legacy_sop_review_id != null)
    .map(d => [d.legacy_sop_review_id, d]));
  const usedSlugs = new Set((existing || []).map(d => d.slug));
  console.log(`sop_documents: ${(existing || []).length} rows, ${byLegacy.size} already from sop_review\n`);

  const now = new Date().toISOString();
  const toInsert = [], toUpdate = [], skipped = [], noTitle = [];

  for (const r of rows) {
    const title = String(r.title || r.proposed_title || r.original_title || '').trim();
    if (!title) { noTitle.push(r.id); continue; }

    const body = String(r.full_text || '').trim();
    const prior = byLegacy.get(r.id);

    // A person has edited this since the last import. Their version wins.
    if (prior && prior.updated_by && !FORCE) { skipped.push({ id: r.id, title: prior.title, by: prior.updated_by }); continue; }

    let slug = slugify(title);
    if (!prior) {
      let n = 2;
      const base = slug;
      while (usedSlugs.has(slug)) slug = `${base}-${n++}`;
      usedSlugs.add(slug);
    }

    const doc = {
      title,
      body_md: body,
      content_hash: hash(body),
      department: DEPARTMENT,
      category: r.category || null,
      // The review tracker's own tags, plus a marker so these 89 stay findable
      // as a set after 450 Slab articles land on top of them.
      tags: [...new Set([...(Array.isArray(r.tags) ? r.tags : []), 'sop-review-2026'])].filter(Boolean).map(String),
      status: STATUS_MAP[r.status] || 'Needs Review',
      // Deliberately NOT set: review_interval_days, last_reviewed_at,
      // next_review_at. sop_review records that somebody made a RECOMMENDATION,
      // not that the procedure was verified on a date — inventing a review date
      // from it would put 89 documents on a schedule nobody actually agreed to.
      source: 'sop_review',
      source_path: r.file || null,
      legacy_sop_review_id: r.id,
      archived: !!r.archived || r.status === 'Archive',
      updated_at: now,
    };

    if (prior) toUpdate.push({ id: prior.id, ...doc });
    else toInsert.push({ ...doc, slug, created_at: now });
  }

  console.log(`to insert : ${toInsert.length}`);
  console.log(`to update : ${toUpdate.length}`);
  console.log(`skipped   : ${skipped.length}  (edited by a person since the last import)`);
  skipped.slice(0, 10).forEach(s => console.log(`              "${s.title}" — last edited by ${s.by}`));
  if (noTitle.length) console.log(`no title  : ${noTitle.length}  (sop_review ids ${noTitle.join(', ')})`);

  const byStatus = {};
  [...toInsert, ...toUpdate].forEach(d => { byStatus[d.status] = (byStatus[d.status] || 0) + 1; });
  console.log('status    :', JSON.stringify(byStatus));
  const empty = [...toInsert, ...toUpdate].filter(d => !d.body_md).length;
  if (empty) console.log(`empty body: ${empty}  (imported anyway — an empty SOP is a real finding, not a reason to drop it)`);

  if (DRY) {
    console.log('\n--dry-run: nothing written.');
    toInsert.slice(0, 5).forEach(d => console.log(`  ${d.slug.padEnd(50)} ${d.status}`));
    return;
  }

  let ins = 0, upd = 0;
  for (let i = 0; i < toInsert.length; i += 100) {
    const { error: e } = await db.from('sop_documents').insert(toInsert.slice(i, i + 100));
    if (e) throw new Error('insert: ' + e.message);
    ins += toInsert.slice(i, i + 100).length;
  }
  for (const d of toUpdate) {
    const { id, ...patch } = d;
    const { error: e } = await db.from('sop_documents').update(patch).eq('id', id);
    if (e) throw new Error('update ' + id + ': ' + e.message);
    upd++;
  }

  console.log(`\ninserted ${ins}, updated ${upd}`);
  console.log('sop_review was not modified.');
  console.log('\nEverything landed in Operations by instruction — Jay reclassifies from the UI:');
  console.log("  select department, count(*) from sop_documents group by 1;");
})().catch(e => { console.error('\nfailed:', e.message); process.exitCode = 1; });
