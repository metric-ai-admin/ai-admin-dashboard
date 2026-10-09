#!/usr/bin/env node
//
// One typo in the English of the 7-Day Turn Process: "you want for supervisor
// approval" should read "you wait". The Spanish translation already says
// "espere la aprobación", so the two versions disagree until this is fixed.
//
//   node scripts/fix-sop-typo-7day.js            # DRY RUN, prints the change
//   node scripts/fix-sop-typo-7day.js --write
//
// IT FOLLOWS THE EDIT ROUTE'S OWN SEQUENCE, not a bare update: the previous
// body is written to sop_versions FIRST, then the document is changed. A
// version written after the fact is a copy of the new text, not a record of
// the old one. See PATCH /api/sop/documents/:id in server.js.
//
// This SOP was bulk-imported on 2026-09-28 and has no version rows, so the
// version this writes is number 1 and holds the text as imported — which is
// exactly what version 1 should be.
//
// Changing the English changes the translation's source hash, so the Spanish
// becomes STALE on its own. No flag is needed to pick it up again.
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const T = require('../lib/sop-translate.js');

const WRITE = process.argv.includes('--write');
const SLUG = '7-day-turn-process';
const FROM = 'you want for supervisor approval';
const TO = 'you wait for supervisor approval';
const NOTE = 'Typo: "want" -> "wait" for supervisor approval';

const db = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } });

(async () => {
  const { data, error } = await db.from('sop_documents')
    .select('id,slug,title,body_md,body_es,es_source_hash,updated_at')
    .eq('slug', SLUG).limit(1);
  if (error) throw new Error(error.message);
  const doc = (data || [])[0];
  if (!doc) throw new Error('no SOP with slug ' + SLUG);

  const hits = doc.body_md.split(FROM).length - 1;
  console.log('document : ' + doc.title);
  console.log('id       : ' + doc.id);
  console.log('matches  : ' + hits + ' occurrence(s) of "' + FROM + '"');

  if (hits !== 1) {
    // Not 1 means the text moved. Guessing which occurrence was meant is how a
    // one-word fix becomes a silent rewrite.
    console.error('\nExpected exactly one occurrence. Refusing to guess.');
    process.exit(2);
  }

  const next = doc.body_md.replace(FROM, TO);
  const i = doc.body_md.indexOf(FROM);
  console.log('\nbefore: ...' + doc.body_md.slice(Math.max(0, i - 70), i + FROM.length + 40).replace(/\s+/g, ' ') + '...');
  console.log('after : ...' + next.slice(Math.max(0, i - 70), i + TO.length + 40).replace(/\s+/g, ' ') + '...');
  console.log('\nlength ' + doc.body_md.length + ' -> ' + next.length + '  (one character)');
  console.log('translation now : ' + T.translationState(doc));
  console.log('translation after: ' + T.translationState({ ...doc, body_md: next })
    + '   <- the Spanish goes stale on its own, and the page falls back to English until it is redone');

  const { data: vers } = await db.from('sop_versions')
    .select('version').eq('document_id', doc.id).order('version', { ascending: false }).limit(1);
  const nextVersion = ((vers && vers[0] && vers[0].version) || 0) + 1;
  console.log('\nwill write sop_versions #' + nextVersion + ' holding the CURRENT (pre-edit) body');

  if (!WRITE) { console.log('\nDRY RUN — nothing written. Re-run with --write.'); return; }

  const now = new Date().toISOString();
  // The previous body first. A failure here stops the edit: losing the old
  // text is worse than refusing the change.
  const { error: vErr } = await db.from('sop_versions').insert({
    document_id: doc.id, version: nextVersion, title: doc.title, body_md: doc.body_md,
    changed_by: 'Arturo Mendoza', changed_at: now, note: NOTE,
  });
  if (vErr) throw new Error('could not record the previous version: ' + vErr.message);
  console.log('version ' + nextVersion + ' recorded');

  const { error: uErr } = await db.from('sop_documents')
    .update({ body_md: next, updated_at: now, updated_by: 'Arturo Mendoza' })
    .eq('id', doc.id);
  if (uErr) throw new Error(uErr.message);
  console.log('document updated');

  const { data: after } = await db.from('sop_documents')
    .select('body_md,body_es,es_source_hash,title').eq('id', doc.id).limit(1);
  console.log('verified: "' + TO + '" present: ' + (after[0].body_md.includes(TO)));
  console.log('translation state now: ' + T.translationState(after[0]));
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
