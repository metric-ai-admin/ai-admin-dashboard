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

// SEVERAL NAMES IN ONE RUN. Finding where a fact lives means trying the
// handful of reports it could be in, and one name per invocation turns that
// into six round trips to a shell somebody has to keep open.
const WANTED = process.argv.slice(2).filter(a => !a.startsWith('--'));
const WANT = WANTED[0];
const clean = s => String(s == null ? '' : s).trim();

// The maintenance sync's path, copied: Reports API credentials, the hard-coded
// host, and paginate_results:false. Nothing is written.
async function reportsApiPull(report) {
  const id = process.env.APPFOLIO_REPORTS_CLIENT_ID;
  const secret = process.env.APPFOLIO_REPORTS_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error('APPFOLIO_REPORTS_CLIENT_ID / APPFOLIO_REPORTS_CLIENT_SECRET are not set '
      + 'in this shell. These are the Reports API credentials the maintenance sync uses, '
      + 'not APPFOLIO_CLIENT_ID. Run this on Render.');
  }
  const url = 'https://metricpropertymanagement.appfolio.com/api/v2/reports/'
    + encodeURIComponent(report) + '.json';
  const resp = await global.fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(id + ':' + secret).toString('base64'),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ property_visibility: 'active', paginate_results: false }),
  });
  if (!resp.ok) {
    const j = await resp.json().catch(() => null);
    throw new Error('AppFolio ' + resp.status + ': '
      + ((j && (j.error || j.message)) || resp.statusText));
  }
  const j = await resp.json().catch(() => null);
  // paginate_results:false answers with a bare array. The other shapes are
  // accepted so a change at AppFolio's end does not read as "no rows".
  return Array.isArray(j) ? j : ((j && (j.results || j.data)) || []);
}

(async () => {
  const af = require('../appfolio-reports.js');
  const { fetchReport } = require('../appfolio-client.js');

  if (WANTED.length > 1) {
    // Each one on its own, and a failure on one does not lose the others: a
    // report name that does not exist is an ANSWER, and the run has to get to
    // the next candidate to be worth starting.
    for (const name of WANTED) {
      console.log('\n' + '='.repeat(72));
      try {
        await describe(name, af, fetchReport);
      } catch (e) {
        console.log(name + ': ' + e.message);
        console.log('   (a name AppFolio rejects is an answer — the fact is not there)');
      }
    }
    return;
  }

  await describe(WANT, af, fetchReport);
})().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });

async function describe(WANT, af, fetchReport) {
  if (!WANT) {
    console.log('Pass a report id or an AppFolio report NAME. Registered reports:');
    (af.REPORTS || []).forEach(r => console.log('   ' + r.id.padEnd(30) + r.label));
    console.log('\nAny other name is fetched straight from the Reports API, e.g.');
    console.log('   node scripts/probe-report-columns.js inspection_detail');
    process.exitCode = 2;
    return;
  }

  const def = (af.REPORTS || []).find(r => r.id === WANT);

  // NOT EVERY REPORT IS IN THE REGISTRY. inspection_detail is pulled by the
  // maintenance sync through appfolioReportsFetch() in server.js, not through
  // appfolio-reports.js — so "Pass a report id" was the only answer this script
  // had for the one report somebody needed to look at.
  //
  // An unregistered name is treated as an AppFolio report name and fetched the
  // way that sync fetches it. The two paths are NOT interchangeable: different
  // credentials, a hard-coded host, and paginate_results:false, which makes
  // AppFolio answer with a bare array that fetchReport() cannot unwrap. See
  // scripts/probe-inspection-review.js, where getting this wrong looked like a
  // 404 about a wrong report name.
  let rows;
  let label;
  if (def) {
    const params = typeof def.params === 'function' ? def.params() : (def.params || {});
    console.log('Fetching ' + def.resource + ' live from AppFolio (registered; nothing is saved)…');
    const fetched = await fetchReport(def.resource, params);
    rows = fetched.rows || [];
    label = WANT + ': ' + rows.length + ' rows, ' + fetched.pages + ' page(s)';
  } else {
    console.log('"' + WANT + '" is not a registered report — fetching it as an AppFolio '
      + 'report name through the Reports API (nothing is saved)…');
    rows = await reportsApiPull(WANT);
    label = WANT + ': ' + rows.length + ' rows';
  }
  console.log(label);
  if (!rows.length) { console.log('The report returned nothing. That is the answer.'); return; }

  // Every key seen on ANY row: these reports omit empty columns on some rows,
  // and the column being looked for may be the one that is empty on most.
  const columns = new Set();
  rows.forEach(r => Object.keys(r || {}).forEach(k => columns.add(k)));
  const list = [...columns].sort();

  // What the registered projection would do with each column, which is the
  // question being asked. A column marked DROPPED that holds the phone numbers
  // is the bug, stated.
  const projected = def && typeof def.project === 'function'
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
}
