#!/usr/bin/env node
//
// What columns does inspection_detail actually return?
//
//   node scripts/probe-inspection-columns.js
//
// READ ONLY. One report read. Nothing is written to AppFolio or Supabase.
//
// RUN IT AFTER 6 PM CT. AppFolio rate-limits during business hours and a 429
// is not an answer — it is the same empty response as a report that has no
// rows, which is how a wrong conclusion gets written down.
//
// WHY IT EXISTS. The sync keeps ELEVEN of this report's columns and silently
// drops the rest, so a field could have been in every response since the sync
// was written and never once reached the database. The question that needs it:
// can we tell an inspection with photos and areas from an empty one? Today we
// cannot — `status` says whether somebody clicked Done, not whether there is
// anything inside — and Erick's 2026-10-14 review found inspections marked
// DONE with nothing in them.
//
// NOTHING BUT COLUMN NAMES AND FILL COUNTS IS PRINTED. These rows carry
// residents, units and free-text notes. A probe that dumps a sample row to
// "see the shape" is how an applicant's salary reached a terminal once
// already.
require('dotenv').config();

const ID = process.env.APPFOLIO_REPORTS_CLIENT_ID;
const SECRET = process.env.APPFOLIO_REPORTS_CLIENT_SECRET;
const HOST = process.env.APPFOLIO_REPORTS_HOST || 'metricpropertymanagement.appfolio.com';

const pad = (s, w) => String(s).padEnd(w);

// What we already keep, so the output says which columns are NEW rather than
// leaving somebody to diff two lists by eye.
const STORED = ['inspection_id', 'inspection_name', 'property_name', 'unit',
  'primary_resident', 'status', 'inspected_on', 'marked_done_on', 'marked_done_by',
  'created_on', 'property_id', 'unit_turn_id', 'unit_id', 'occupancy_id'];

// The question this is really asking.
const INTERESTING = /area|photo|image|attach|item|note|comment|count|url|link|template|signature|score|complete/i;

(async () => {
  if (!ID || !SECRET) {
    console.error('APPFOLIO_REPORTS_CLIENT_ID / _SECRET are not set in this shell. Run on Render.');
    process.exitCode = 1;
    return;
  }

  const r = await global.fetch('https://' + HOST + '/api/v2/reports/inspection_detail.json', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(ID + ':' + SECRET).toString('base64'),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ property_visibility: 'active', paginate_results: false }),
  });
  const text = await r.text();
  if (r.status === 429) {
    console.error('429 — rate limited. This is NOT "the report has no columns". Run it after 6 PM CT.');
    process.exitCode = 1;
    return;
  }
  if (!r.ok) {
    console.error('REJECTED ' + r.status + ' — ' + text.slice(0, 200));
    process.exitCode = 1;
    return;
  }
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not json */ }
  const rows = Array.isArray(json) ? json : ((json && (json.results || json.data)) || []);
  if (!rows.length) {
    console.log('0 rows. Nothing can be concluded about the columns from this.');
    return;
  }

  // The union of keys, because a column can be absent from one row's object.
  const cols = new Map();
  rows.forEach(row => {
    Object.keys(row || {}).forEach(k => {
      if (!cols.has(k)) cols.set(k, 0);
      const v = row[k];
      if (v !== null && v !== undefined && String(v).trim() !== '') {
        cols.set(k, cols.get(k) + 1);
      }
    });
  });

  console.log('inspection_detail — ' + rows.length + ' rows, ' + cols.size + ' columns\n');
  console.log(pad('column', 34) + pad('filled', 14) + 'status');
  [...cols.keys()].sort().forEach(k => {
    const filled = cols.get(k);
    const known = STORED.includes(k);
    console.log('  ' + pad(k, 32) + pad(filled + '/' + rows.length, 14)
      + (known ? 'stored' : 'NOT STORED')
      + (INTERESTING.test(k) ? '   <-- look at this one' : ''));
  });

  const newOnes = [...cols.keys()].filter(k => !STORED.includes(k));
  console.log('\n' + newOnes.length + ' column(s) the sync has never kept.');
  const useful = newOnes.filter(k => INTERESTING.test(k));
  console.log(useful.length
    ? 'Of those, these could answer "does this inspection have anything in it": '
      + useful.join(', ')
    : 'None of them looks like areas, photos or a URL — "has content" stays '
      + 'unanswerable from this report, and status is the best rule available.');

  console.log('\nNothing was written. No value from any row was printed.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
