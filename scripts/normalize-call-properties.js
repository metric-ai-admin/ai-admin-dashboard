#!/usr/bin/env node
//
// Normalise call_grades.property_name against the property list.
//
//   node scripts/normalize-call-properties.js            # DRY RUN
//   node scripts/normalize-call-properties.js --write
//
// WHY ONLY SOME OF IT. The column is written by the grading model from what it
// heard, and on 2026-10-13 it held 300+ distinct values over 1,847 rows. 995
// are "Unidentified". The obvious variants are worth fixing; street addresses,
// former properties and buildings that are not ours are not, and a fuzzy
// matcher that tidied them would file somebody else's building under one of
// ours. A wrong attribution looks exactly like a right one.
//
// So this maps what lib/property-aliases.js is sure of, REPORTS what it is
// leaving alone, and never guesses.
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const { selectAll } = require('../lib/db-page.js');
const PA = require('../lib/property-aliases.js');

const WRITE = process.argv.includes('--write');

const db = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } });

const pad = (s, w) => String(s).padEnd(w);

(async () => {
  const rows = await selectAll(() => db.from('call_grades').select('id,property_name'),
    { label: 'call_grades' });
  const p = PA.plan(rows);

  console.log('call_grades: ' + p.rows + ' rows, ' + p.distinct + ' distinct property names');
  console.log('');
  console.log('WOULD CHANGE: ' + p.rowsChanged + ' rows across ' + p.change.length + ' spellings');
  p.change.forEach(c => console.log('   ' + String(c.rows).padStart(5) + '  '
    + pad(c.from, 32) + '->  ' + c.to));

  const already = p.keep.filter(k => k.canonical);
  console.log('\nalready canonical: ' + already.reduce((a, k) => a + k.rows, 0) + ' rows');
  already.forEach(k => console.log('   ' + String(k.rows).padStart(5) + '  ' + k.value));

  const left = p.keep.filter(k => !k.canonical);
  const leftRows = left.reduce((a, k) => a + k.rows, 0);
  console.log('\nLEFT ALONE: ' + leftRows + ' rows across ' + left.length + ' values');
  console.log('   The top twenty — the rest are one row each:');
  left.slice(0, 20).forEach(k => console.log('   ' + String(k.rows).padStart(5) + '  ' + k.value));
  const singles = left.filter(k => k.rows === 1).length;
  console.log('   ' + singles + ' of those appear exactly once — transcription noise, not properties.');

  console.log('\nAfter this run, ' + leftRows + ' of ' + p.rows + ' rows ('
    + ((100 * leftRows) / p.rows).toFixed(0) + '%) still have no property.');
  console.log('Most of that is "Unidentified", which is an honest answer and not');
  console.log('something a rename can fix — it needs the grading prompt to ask for a');
  console.log('property from a known list rather than from the transcript.');

  if (!WRITE) { console.log('\nDRY RUN — nothing written. Re-run with --write.'); return; }

  // The backup is every row's CURRENT name, not just the ones about to change.
  // A restore that only knows about the 272 rows this run touched cannot undo a
  // run that mapped more than it should have, and the whole reason to take a
  // backup is the case where the plan was wrong.
  //
  // exports/ is gitignored and lives on the Render disk, which is why the file
  // name carries the stamp and the undo is printed below rather than assumed.
  const fs = require('fs');
  const pathm = require('path');
  const dir = pathm.join(__dirname, '..', 'exports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = pathm.join(dir, 'call_grades_property_name_' + stamp + '.json');
  fs.writeFileSync(backup, JSON.stringify(
    rows.map(r => ({ id: r.id, property_name: r.property_name })), null, 0));
  console.log('\nbackup: ' + backup + ' (' + rows.length + ' rows)');
  console.log('undo:   node scripts/restore-call-properties.js "' + backup + '"');

  // One update per spelling, not per row: 1,847 updates to change 300 rows
  // would be 1,500 round trips doing nothing.
  let changed = 0;
  for (const c of p.change) {
    // Marked 'normalised': the model DID name this property, we only corrected
    // the spelling. That is a different claim from 'resident_match', where the
    // model said nothing and the number told us.
    const SRC = require('../lib/call-property.js').SOURCE.NORMALISED;
    let { data, error } = await db.from('call_grades')
      .update({ property_name: c.to, property_source: SRC })
      .eq('property_name', c.from).select('id');
    if (error && /property_source/.test(error.message || '')) {
      ({ data, error } = await db.from('call_grades')
        .update({ property_name: c.to }).eq('property_name', c.from).select('id'));
    }
    if (error) { console.log('FAILED ' + c.from + ': ' + error.message); continue; }
    changed += (data || []).length;
    console.log('   ' + pad(c.from, 32) + '-> ' + pad(c.to, 24) + (data || []).length + ' rows');
  }
  console.log('\nchanged: ' + changed + ' rows');

  const after = await selectAll(() => db.from('call_grades').select('property_name'),
    { label: 'verify' });
  const q = PA.plan(after);
  console.log('verified: ' + q.distinct + ' distinct names now, '
    + q.rowsChanged + ' still mappable (should be 0)');
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
