#!/usr/bin/env node
//
// Which date parameter the Rental Applications report actually honours.
// READ ONLY — nothing is written to Supabase or to any store.
// NO PERSONAL DATA IS PRINTED — see lib/safe-print.js.
//
//   node scripts/probe-applications-report.js
//
// WHY. Katie's export carries 123 applications and the sync returns 20,
// received 2026-09-12..2026-10-09 — about four weeks. Asking for everything
// gets four weeks, so the report has a default window and the only way past
// it is a date parameter under the name it expects.
//
// SHOWINGS HAD EXACTLY THIS PROBLEM. `from_date` was ignored there; the
// spelling that worked was `showing_date_from` / `showing_date_to`, and the
// note in server.js is worth repeating here:
//
//     An ignored parameter looks exactly like one that works.
//
// A request that comes back with the same 20 rows has not been narrowed or
// widened — it has been ignored. So every candidate is measured against a
// BASELINE taken with no parameters at all, and anything matching the
// baseline is reported as ignored rather than as working.
//
// TWO CORRECTIONS TO THE FIRST VERSION OF THIS SCRIPT, both mine:
//
//   1. It called through appfolio-client (APPFOLIO_CLIENT_ID), while the sync
//      calls the Reports API with APPFOLIO_REPORTS_CLIENT_ID. Two different
//      doors. That is why five of six cases came back 0 while the sync
//      returned 20 with the parameters one of those cases used — the zeros
//      were about the client, not about the parameters, and the conclusion
//      drawn from them ("her window gives 0") should be thrown away.
//
//   2. It printed a whole sample row, including an applicant's email, phone,
//      employer and salary.
require('dotenv').config();

const SP = require('../lib/safe-print.js');

const BASE = 'https://' + (process.env.APPFOLIO_REPORTS_SUBDOMAIN
  || process.env.APPFOLIO_SUBDOMAIN || '') + '.appfolio.com';
const REPORT = '/api/v2/reports/rental_applications.json';
const FROM = '2026-07-01';
const TO = '2026-10-12';

// Every spelling worth trying, named after the column the report calls the
// date: `received`. The showings answer was <column>_from / <column>_to, so
// that shape leads.
const CANDIDATES = [
  ['received_from / received_to', { received_from: FROM, received_to: TO }],
  ['received_date_from / _to', { received_date_from: FROM, received_date_to: TO }],
  ['received_on_from / _to', { received_on_from: FROM, received_on_to: TO }],
  ['application_received_from / _to', { application_received_from: FROM, application_received_to: TO }],
  ['application_date_from / _to', { application_date_from: FROM, application_date_to: TO }],
  ['date_range_from / _to', { date_range_from: FROM, date_range_to: TO }],
  ['from_date / to_date', { from_date: FROM, to_date: TO }],
  ['from / to', { from: FROM, to: TO }],
  ['start_date / end_date', { start_date: FROM, end_date: TO }],
  ['received_at_from / _to', { received_at_from: FROM, received_at_to: TO }],
  ['lease_start_date_from / _to', { lease_start_date_from: FROM, lease_start_date_to: TO }],
  ['move_in_date_from / _to', { move_in_date_from: FROM, move_in_date_to: TO }],
];

const id = process.env.APPFOLIO_REPORTS_CLIENT_ID;
const secret = process.env.APPFOLIO_REPORTS_CLIENT_SECRET;
const auth = 'Basic ' + Buffer.from(id + ':' + secret).toString('base64');
const pull = o => (Array.isArray(o) ? o : ((o && (o.results || o.data)) || []));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// The same door the sync uses, following next_page_url the same way.
async function ask(params) {
  const rows = [];
  let res = await fetch(BASE + REPORT, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ property_visibility: 'active', paginate_results: false }, params)),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => null);
    const e = new Error((j && (j.error || j.message)) || ('HTTP ' + res.status));
    e.status = res.status;
    throw e;
  }
  let j = await res.json();
  rows.push(...pull(j));
  let next = j && j.next_page_url, guard = 0;
  while (next && guard++ < 100) {
    await sleep(2200);
    const u = /^https?:\/\//i.test(next) ? next : BASE + next;
    res = await fetch(u, { headers: { Authorization: auth } });
    if (!res.ok) break;
    j = await res.json();
    rows.push(...pull(j));
    next = j && j.next_page_url;
  }
  return rows;
}

const ymd = v => SP.clean(v).slice(0, 10);
const span = rows => {
  const d = rows.map(r => ymd(r.received)).filter(Boolean).sort();
  return d.length ? d[0] + '..' + d[d.length - 1] : '—';
};
const idsOf = rows => new Set(rows.map(r => SP.clean(r.rental_application_id)).filter(Boolean));

(async () => {
  if (!id || !secret) {
    console.error('APPFOLIO_REPORTS_CLIENT_ID / _SECRET are not set here — run this on Render.');
    process.exit(2);
  }

  console.log('Reports API, the same credentials and endpoint the sync uses.');
  console.log('Window asked for: ' + FROM + ' .. ' + TO + '\n');

  const baseline = await ask({});
  const baseIds = idsOf(baseline);
  console.log('BASELINE, no date parameter at all: ' + baseline.length + ' rows, received ' + span(baseline));
  console.log('Anything returning the same set has been IGNORED, not applied.\n');

  const hits = [];
  for (const [label, params] of CANDIDATES) {
    await sleep(2200);
    let rows, err = null;
    try { rows = await ask(params); } catch (e) { err = e; rows = []; }
    if (err) {
      // A 400 naming the parameter is a USEFUL answer: the report knows the
      // name and dislikes the value, which is closer than silence.
      console.log('  ERR   ' + label.padEnd(34) + err.status + ' ' + err.message.slice(0, 70));
      continue;
    }
    const ids = idsOf(rows);
    const same = ids.size === baseIds.size && [...ids].every(x => baseIds.has(x));
    const verdict = same ? 'ignored — identical to baseline'
      : (rows.length > baseline.length ? 'WIDENED' : 'changed the set');
    console.log('  ' + String(rows.length).padStart(5) + ' ' + label.padEnd(34)
      + span(rows).padEnd(24) + verdict);
    if (!same) hits.push({ label, params, n: rows.length, rows });
  }

  if (!hits.length) {
    console.log('\nEvery candidate was ignored. The window is not reachable by any of these');
    console.log('names, and the next place to look is her saved report definition in');
    console.log('AppFolio — the parameter it sends is the one to copy.');
    return;
  }

  const best = hits.sort((a, b) => b.n - a.n)[0];
  console.log('\nMOST ROWS: ' + best.n + ' — ' + best.label);
  console.log('params: ' + JSON.stringify(best.params));
  console.log('Katie’s file carries 123 for 2026-07-15..2026-10-09.');

  // Column names and FILL RATES only. No values from the personal columns.
  console.log('\ncolumns, and how many of the ' + best.n + ' rows carry a value:');
  SP.fillRates(best.rows).forEach(l => console.log(l));

  console.log('\nnon-personal sample (one row, redacted):');
  Object.entries(SP.safeRow(best.rows[0] || {}))
    .filter(([k]) => SP.isSafe(k))
    .forEach(([k, v]) => console.log('   ' + k.padEnd(34) + JSON.stringify(v)));

  console.log('\nNothing was written. This script only reads.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
