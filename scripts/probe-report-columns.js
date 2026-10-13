#!/usr/bin/env node
//
// The column names a report returns FROM APPFOLIO, before any projection, and
// how many rows carry a value in each. READ ONLY. NO VALUES ARE PRINTED — not
// one, from any column.
//
//   node scripts/probe-report-columns.js tenant_directory
//   node scripts/probe-report-columns.js            # lists the reports
//
// WHY THIS AND NOT probe-store-columns.js. That one reads the SAVED store, so
// it can only ever show the columns a projection already kept. tenant_directory
// synced 411 rows and contributed 0 phone numbers: the projection asked for
// `phone` and `mobile`, the report calls them something else, and the store
// cannot say what — the columns were dropped before it was written. The only
// way to find a name a projection threw away is to look at the response.
//
// NOTHING IS WRITTEN. The rows are held in memory, counted, and dropped. This
// report carries resident dates of birth, which is exactly why the projection
// exists, and it is also why this prints names and counts and nothing else.
// A probe that printed one row to get a column name once printed an
// applicant's email, phone, employer and salary with it.
require('dotenv').config();

const SP = require('../lib/safe-print.js');

const WANT = process.argv[2];
const clean = s => String(s == null ? '' : s).trim();

(async () => {
  const af = require('../appfolio-reports.js');
  const { fetchReport } = require('../appfolio-client.js');

  const def = (af.REPORTS || []).find(r => r.id === WANT);
  if (!def) {
    console.log('Pass a report id. Registered:');
    (af.REPORTS || []).forEach(r => console.log('   ' + r.id.padEnd(30) + r.label));
    process.exit(2);
  }

  const params = typeof def.params === 'function' ? def.params() : (def.params || {});
  console.log('Fetching ' + def.resource + ' live from AppFolio (nothing is saved)…');
  const fetched = await fetchReport(def.resource, params);
  const rows = fetched.rows || [];
  console.log(WANT + ': ' + rows.length + ' rows, ' + fetched.pages + ' page(s)');
  if (!rows.length) { console.log('The report returned nothing. That is the answer.'); return; }

  // Every key seen on ANY row: these reports omit empty columns on some rows,
  // and the column being looked for may be the one that is empty on most.
  const columns = new Set();
  rows.forEach(r => Object.keys(r || {}).forEach(k => columns.add(k)));
  const list = [...columns].sort();

  // What the registered projection would do with each column, which is the
  // question being asked. A column marked DROPPED that holds the phone numbers
  // is the bug, stated.
  const projected = typeof def.project === 'function'
    ? new Set(Object.keys(def.project(Object.fromEntries(list.map(k => [k, 'x'])))))
    : null;
  const kept = k => {
    if (!projected) return '';
    // The projection renames, so a kept column cannot be matched by name alone.
    // This is a hint, not a contract: the test in test/call-match.test.js is
    // what actually pins the projection's behaviour.
    return projected.has(k) ? '' : '   DROPPED by the projection';
  };

  const PHONEISH = /phone|mobile|cell|tel\b|contact/i;

  console.log('\n' + list.length + ' columns, and how many of the ' + rows.length
    + ' rows carry a value:\n');
  list.forEach(k => {
    const n = rows.filter(r => clean(r[k])).length;
    const pct = ((100 * n) / rows.length).toFixed(0);
    console.log('   ' + k.padEnd(34) + String(n).padStart(5) + '  ' + String(pct).padStart(3) + '%'
      + (SP.isSafe(k) ? '' : '   [personal — values never printed]')
      + (PHONEISH.test(k) ? '   <-- phone-ish' : '')
      + kept(k));
  });

  const phones = list.filter(k => PHONEISH.test(k));
  console.log('\nphone-ish columns: ' + (phones.length ? phones.join(', ') : 'NONE — '
    + 'this report does not carry a phone number at all, and the match needs a '
    + 'different source'));
  console.log('\nNothing was written, and no cell value was printed.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
