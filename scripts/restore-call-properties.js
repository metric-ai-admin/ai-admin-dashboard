#!/usr/bin/env node
//
// Put back the property names normalize-call-properties.js --write changed.
//
//   node scripts/restore-call-properties.js exports/call_grades_property_name_<stamp>.json
//   ... takes --dry-run
//
// A backup nobody can restore from is a comfort, not a safeguard — the same
// reason scripts/restore-call-grades.js exists.
//
// Only rows whose name DIFFERS from the backup are written, so a restore run
// twice is a no-op rather than 1,896 pointless updates, and the count it
// prints is the number of rows it actually put back.
require('dotenv').config();

const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const { selectAll } = require('../lib/db-page.js');

const DRY = process.argv.includes('--dry-run');
const file = process.argv.slice(2).find(a => !a.startsWith('--'));
if (!file) { console.error('usage: restore-call-properties.js <backup.json> [--dry-run]'); process.exit(1); }

const db = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } });

(async () => {
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  const want = new Map(saved.map(r => [r.id, r.property_name]));
  console.log('backup: ' + saved.length + ' rows');

  const now = await selectAll(() => db.from('call_grades').select('id,property_name'),
    { label: 'call_grades' });

  // A restore puts property_source back to NULL along with the name. Leaving
  // it reading 'resident_match' over a value the match did not produce would
  // be a worse state than the one being undone — the column exists to say
  // where the value came from, and after a restore the honest answer is
  // "whatever it was before", which is what NULL means on these rows.
  const todo = now.filter(r => want.has(r.id) && want.get(r.id) !== r.property_name);
  const gone = saved.filter(r => !now.some(n => n.id === r.id));
  console.log('differ: ' + todo.length + ' rows');
  if (gone.length) console.log('no longer present: ' + gone.length + ' rows (reported, not recreated)');

  if (DRY || !todo.length) { console.log(DRY ? '\nDRY RUN — nothing written.' : '\nnothing to do.'); return; }

  let done = 0;
  for (const r of todo) {
    let { error } = await db.from('call_grades')
      .update({ property_name: want.get(r.id), property_source: null }).eq('id', r.id);
    // Before migration 092 the column does not exist; the name still goes back.
    if (error && /property_source/.test(error.message || '')) {
      ({ error } = await db.from('call_grades')
        .update({ property_name: want.get(r.id) }).eq('id', r.id));
    }
    if (error) { console.log('FAILED ' + r.id + ': ' + error.message); continue; }
    done++;
  }
  console.log('restored: ' + done + ' rows');
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
