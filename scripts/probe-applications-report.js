#!/usr/bin/env node
//
// What the Rental Applications report returns, and under which parameters.
// READ ONLY — nothing is written to Supabase or to any store.
//
//   node scripts/probe-applications-report.js
//
// WHY. On 2026-10-12 Katie's apps tab carried 123 applications and
// leasing_applications held 70 — a clean subset, every one of ours inside
// hers, 53 missing across all seven properties. A manual sync that morning
// returned TWENTY rows while the table already held 67, which is the shape
// that matters: the table has been accumulating a different ~20 on each run
// rather than being refreshed with the whole set.
//
// Our call is the only one of the three leasing syncs that passes a date:
//
//   showings        { property_visibility, paginate_results }      467 rows
//   lease_history   { property_visibility, paginate_results }       79 rows
//   applications    { from_date, property_visibility, paginate }    20 rows
//
// So the suspicion is that `from_date` does not filter on Received at all —
// her 123 are all Received between 2026-07-15 and 2026-10-09, every one of
// them after the 2026-01-01 we send, so a Received filter could not drop one.
// A filter on a date that MOVES — last updated, decision made — would return a
// different handful every day and build exactly the table we have.
//
// This asks the report the same question several ways and prints the counts
// side by side. Whichever call returns ~123 is the one the sync should make.
require('dotenv').config();

const CASES = [
  ['as the sync calls it today', { from_date: '2026-01-01', property_visibility: 'active', paginate_results: false }],
  ['no date at all, like lease_history', { property_visibility: 'active', paginate_results: false }],
  ['no date, paginated', { property_visibility: 'active', paginate_results: true }],
  ['no date, no visibility filter', { paginate_results: false }],
  ['a date far enough back to be harmless', { from_date: '2020-01-01', property_visibility: 'active', paginate_results: false }],
  ['her window, by received', { from_date: '2026-07-01', to_date: '2026-10-12', property_visibility: 'active', paginate_results: false }],
];

const clean = s => String(s == null ? '' : s).trim();
const ymd = v => clean(v).slice(0, 10);

(async () => {
  const client = require('../appfolio-client.js');
  if (client.isConfigured && !client.isConfigured()) {
    console.error('AppFolio is not configured here — run this on Render.');
    process.exit(2);
  }

  const results = [];
  for (const [label, params] of CASES) {
    try {
      const r = await client.fetchReport('rental_applications', params);
      const rows = r.rows || r || [];
      results.push({ label, params, n: rows.length, rows });
      console.log(String(rows.length).padStart(5) + '  ' + label);
    } catch (e) {
      results.push({ label, params, n: null, error: e.message });
      console.log('  ERR  ' + label + ' — ' + e.message);
    }
  }

  const best = results.filter(r => r.n != null).sort((a, b) => b.n - a.n)[0];
  if (!best || !best.n) { console.log('\nNothing came back. Nothing more to say from here.'); return; }

  console.log('\nMOST ROWS: ' + best.n + ' — ' + best.label);
  console.log('params: ' + JSON.stringify(best.params));

  const sample = best.rows[0] || {};
  console.log('\ncolumns (' + Object.keys(sample).length + '):');
  Object.keys(sample).sort().forEach(k => console.log('   ' + k.padEnd(34) + JSON.stringify(sample[k])));

  // THE COLUMN HER RULE NEEDS. She excludes "Approved WITH a lease start
  // date"; we do not store one, so the report approximates it with
  // detailed_status. Find out what the field is actually called before adding
  // it, rather than guessing a name into a migration.
  const CANDIDATES = ['lease_start_date', 'lease_start', 'lease_from', 'lease_begin',
    'start_date', 'lease_start_on', 'desired_move_in', 'move_in_date'];
  console.log('\nthe lease-start column, if it is here:');
  const found = CANDIDATES.filter(c => Object.prototype.hasOwnProperty.call(sample, c));
  if (!found.length) {
    console.log('   none of ' + CANDIDATES.join(', '));
    console.log('   Look through the column list above for whatever carries it.');
  } else {
    found.forEach(c => {
      const filled = best.rows.filter(r => clean(r[c])).length;
      console.log('   ' + c.padEnd(24) + filled + ' of ' + best.n + ' rows have a value');
    });
  }

  // Received dates, so the from_date theory is settled rather than argued.
  const recKey = ['received', 'received_date', 'application_date', 'created_at']
    .find(k => Object.prototype.hasOwnProperty.call(sample, k));
  if (recKey) {
    const d = best.rows.map(r => ymd(r[recKey])).filter(Boolean).sort();
    console.log('\n' + recKey + ' ranges ' + d[0] + ' .. ' + d[d.length - 1]
      + '   (' + d.filter(x => x < '2026-01-01').length + ' before 2026-01-01)');
    console.log('If none is before 2026-01-01, the from_date we send cannot be');
    console.log('filtering on this column — it is filtering on something else.');
  }

  const ids = best.rows.map(r => clean(r.rental_application_id)).filter(Boolean);
  console.log('\ndistinct rental_application_id: ' + new Set(ids).size + ' of ' + ids.length);
  console.log('\nNothing was written. This script only reads.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
