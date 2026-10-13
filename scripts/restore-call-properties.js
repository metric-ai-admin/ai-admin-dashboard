#!/usr/bin/env node
//
// Put back the property names a --write run changed.
//
//   node scripts/restore-call-properties.js --batch propfill_2026-10-13T...
//   node scripts/restore-call-properties.js exports/call_grades_property_name_<stamp>.json
//   ... either form takes --dry-run
//
// TWO SOURCES, SAME RESTORE, and they are not equally good.
//
//   --batch   reads call_grades_history (migration 060). It is IN THE DATABASE
//             and survives a Render restart. This is the one to reach for,
//             especially from the Render shell, where a file written by an
//             earlier instance is very likely already gone.
//   <file>    reads an exports/ JSON. Gitignored, on the Render disk, and
//             temporary. It is the convenience copy, not the backup.
//
// A backup nobody can restore from is a comfort, not a safeguard — the same
// reason scripts/restore-call-grades.js exists, and the same split it makes.
//
// ONLY property_name AND property_source are written back. The history row
// holds the whole prior grade, but this script is the undo for a property
// fill: putting back a score or a summary that nothing touched would be a
// second change dressed up as a restore.
//
// Only rows that actually DIFFER are written, so running it twice is a no-op
// rather than 1,896 pointless updates, and the count it prints is the number
// of rows it really put back.
require('dotenv').config();

const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const { selectAll } = require('../lib/db-page.js');

const DRY = process.argv.includes('--dry-run');
const batchAt = process.argv.indexOf('--batch');
const BATCH = batchAt > -1 ? process.argv[batchAt + 1] : null;
const file = batchAt > -1 ? null : process.argv.slice(2).find(a => !a.startsWith('--'));

if (batchAt > -1 && !BATCH) { console.error('--batch needs a batch id'); process.exit(1); }
if (!BATCH && !file) {
  console.error('usage: restore-call-properties.js (--batch <id> | <backup.json>) [--dry-run]');
  process.exit(1);
}

const db = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } });

(async () => {
  // want: id -> { property_name, property_source }
  let want = new Map();

  if (BATCH) {
    const rows = await selectAll(() => db.from('call_grades_history')
      .select('previous,replaced_at,replaced_by').eq('batch_id', BATCH),
    { label: 'history', order: 'replaced_at' });
    if (!rows.length) {
      // Returned, not process.exit: exiting out from under an open HTTP agent
      // trips a libuv assertion on Windows, and a restore script that prints a
      // crash while reporting "nothing found" reads like it broke something.
      console.error('No rows in call_grades_history for batch "' + BATCH + '".');
      console.error('Batches are listed by: select distinct batch_id, replaced_at'
        + ' from call_grades_history order by replaced_at desc;');
      process.exitCode = 2;
      return;
    }
    console.log('batch ' + BATCH + ': ' + rows.length + ' rows, replaced '
      + String(rows[0].replaced_at || '').slice(0, 19) + ' by ' + (rows[0].replaced_by || '—'));
    rows.forEach(h => {
      const p = h.previous || {};
      if (p.id) want.set(p.id, { property_name: p.property_name ?? null, property_source: p.property_source ?? null });
    });
  } else {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    console.log('file: ' + saved.length + ' rows');
    // An older file carries no property_source. null is the honest restore for
    // those: the column did not exist when they were saved, so "what it was
    // before" is nothing.
    saved.forEach(r => want.set(r.id,
      { property_name: r.property_name ?? null, property_source: r.property_source ?? null }));
  }

  const now = await selectAll(() => db.from('call_grades').select('id,property_name,property_source'),
    { label: 'call_grades' });

  const differs = r => {
    const w = want.get(r.id);
    return w && (w.property_name !== r.property_name
      || (w.property_source ?? null) !== (r.property_source ?? null));
  };
  const todo = now.filter(differs);
  const gone = [...want.keys()].filter(id => !now.some(n => n.id === id));

  console.log('differ: ' + todo.length + ' rows');
  if (gone.length) console.log('no longer present: ' + gone.length + ' rows (reported, not recreated)');

  if (DRY || !todo.length) { console.log(DRY ? '\nDRY RUN — nothing written.' : '\nnothing to do.'); return; }

  let done = 0;
  for (const r of todo) {
    const w = want.get(r.id);
    let { error } = await db.from('call_grades')
      .update({ property_name: w.property_name, property_source: w.property_source }).eq('id', r.id);
    // Before migration 092 the column does not exist; the name still goes back.
    if (error && /property_source/.test(error.message || '')) {
      ({ error } = await db.from('call_grades')
        .update({ property_name: w.property_name }).eq('id', r.id));
    }
    if (error) { console.log('FAILED ' + r.id + ': ' + error.message); continue; }
    done++;
  }
  console.log('restored: ' + done + ' rows');
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
