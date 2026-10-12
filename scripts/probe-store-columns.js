#!/usr/bin/env node
//
// The column names in a saved report store, and how many rows carry a value
// in each. READ ONLY. NO VALUES ARE PRINTED — not one, from any column.
//
//   node scripts/probe-store-columns.js occupancy_custom_fields
//   node scripts/probe-store-columns.js            # lists the stores
//
// WHY. The KPI report could not find the eviction stage on the 827 rows of
// Occupancy Custom Fields: it looked for eviction_status, eviction_stage,
// evictionstatus and status and found none of them. Katie's Excel calls the
// column "Eviction Status", so the API calls it something else and the only
// way to know what is to look.
//
// NAMES AND COUNTS, NOTHING ELSE. The last probe that needed a column name
// printed a whole row to get it and printed an applicant's email, phone,
// employer and salary with it. This one cannot do that: it never reads a cell
// except to ask whether it is empty. That is also enough to answer the
// question — the eviction column is the one with roughly 120 of 827 filled.
require('dotenv').config();

const SP = require('../lib/safe-print.js');

const WANT = process.argv[2];
const clean = s => String(s == null ? '' : s).trim();

(async () => {
  const af = require('../appfolio-reports.js');

  if (!WANT) {
    console.log('Pass a store id. Registered reports:');
    (af.REPORTS || []).forEach(r => console.log('   ' + r.id.padEnd(30) + r.label));
    process.exit(2);
  }

  let data;
  try { data = await af.readReportData(WANT); }
  catch (e) { console.error('Could not read "' + WANT + '": ' + e.message); process.exit(1); }
  if (!data) { console.error('No store for "' + WANT + '" on this machine — run this on Render.'); process.exit(2); }

  const rows = data.rows || [];
  console.log(WANT + ': ' + rows.length + ' rows, fetched ' + (data.fetchedAt || '(unknown)'));
  if (!rows.length) { console.log('The store is empty. That is the answer.'); return; }

  // Every key seen on ANY row, not just the first: these reports omit empty
  // columns on some rows, and the column being looked for is the one that is
  // empty on most of them.
  const columns = new Set();
  rows.forEach(r => Object.keys(r || {}).forEach(k => columns.add(k)));
  const list = [...columns].sort();

  const filled = {};
  list.forEach(k => { filled[k] = rows.filter(r => clean(r[k])).length; });

  console.log('\n' + list.length + ' columns, and how many of the ' + rows.length + ' rows carry a value:\n');
  list.forEach(k => {
    const n = filled[k];
    const pct = ((100 * n) / rows.length).toFixed(0);
    // A marker on the ones in the range the eviction column should be in:
    // present on a minority, which is what a stage set on some residents
    // looks like. Not a guess at the answer — a shortlist to read.
    const interesting = n > 0 && n < rows.length * 0.5 ? '  <--' : '';
    console.log('   ' + k.padEnd(40) + String(n).padStart(5) + '  ' + String(pct).padStart(3) + '%'
      + (SP.isSafe(k) ? '' : '   [personal — values never printed]') + interesting);
  });

  console.log('\nThe eviction stage is a column filled on a minority of rows —');
  console.log('about 120 of 827 on Katie’s 2026-10-12 export. Give me the name and');
  console.log('I will pin it; it goes in evictions.js STATUS_FIELDS.');
  console.log('\nNothing was written, and no cell value was printed.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
