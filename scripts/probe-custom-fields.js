#!/usr/bin/env node
//
// The STRUCTURE of a nested custom_fields column. READ ONLY.
// NO VALUE IS EVER PRINTED — only shapes, field names and counts.
//
//   node scripts/probe-custom-fields.js occupancy_custom_fields
//   node scripts/probe-custom-fields.js <store> <column>
//
// WHY. occupancy_custom_fields returns five columns and everything Katie's tab
// shows as its own column — Eviction Status, JP Court Date, Cause, Payment
// Amount — lives inside one of them. The values are residents' court dates,
// payment plans and eviction stages, which is exactly the data a diagnostic
// has no business printing, so this reports the SHAPE and the NAMES and stops
// there.
require('dotenv').config();

const CF = require('../lib/custom-fields.js');

const STORE = process.argv[2] || 'occupancy_custom_fields';
const COLUMN = process.argv[3] || 'custom_fields';

(async () => {
  let data;
  try { data = await require('../appfolio-reports.js').readReportData(STORE); }
  catch (e) { console.error('Could not read "' + STORE + '": ' + e.message); process.exit(1); }
  if (!data) { console.error('No store for "' + STORE + '" here — run this on Render.'); process.exit(2); }

  const rows = data.rows || [];
  console.log(STORE + ': ' + rows.length + ' rows, fetched ' + (data.fetchedAt || '(unknown)'));
  if (!rows.length) { console.log('The store is empty.'); return; }

  const top = new Set();
  rows.forEach(r => Object.keys(r || {}).forEach(k => top.add(k)));
  console.log('top-level columns: ' + [...top].sort().join(', '));

  if (!top.has(COLUMN)) {
    console.error('\nNo "' + COLUMN + '" column. Pass the right one as the second argument.');
    process.exit(2);
  }

  const d = CF.describe(rows, { column: COLUMN });
  console.log('\n"' + COLUMN + '" — what shape it is, row by row:');
  Object.entries(d.shapes).sort((a, b) => b[1] - a[1])
    .forEach(([s, n]) => console.log('   ' + String(n).padStart(5) + '  ' + s));
  console.log('\nentries found: ' + d.entries);
  console.log('keys on each entry: ' + (d.entryKeys.length ? d.entryKeys.join(', ') : '(none — not an array of objects)'));
  if (d.entryKeys.length) {
    console.log('   name read from the first of: ' + CF.NAME_KEYS.join(', '));
    console.log('   value read from the first of: ' + CF.VALUE_KEYS.join(', '));
  }

  const counts = CF.fieldCounts(rows, { column: COLUMN });
  if (!counts.length) {
    console.log('\nNo field names came out. The shape above is not one this reads —');
    console.log('tell me what it says and I will add it to lib/custom-fields.js.');
    return;
  }

  console.log('\n' + counts.length + ' distinct field names, and how many of the '
    + rows.length + ' rows carry a value in each:\n');
  counts.forEach(c => {
    // The eviction stage is the one set on a minority — about 120 of 827.
    const mark = c.filled > 0 && c.filled < rows.length * 0.5 ? '  <--' : '';
    console.log('   ' + c.name.padEnd(40) + String(c.filled).padStart(5) + ' filled'
      + String(c.present).padStart(7) + ' present' + mark);
  });

  const ev = counts.find(c => /eviction\s*status/i.test(c.name));
  console.log('\n' + (ev
    ? 'FOUND "' + ev.name + '" — ' + ev.filled + ' of ' + rows.length + ' rows carry a stage.'
    : 'No field matching /eviction status/. The list above is what there is.'));
  console.log('\nNothing was written, and no field VALUE was printed.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
