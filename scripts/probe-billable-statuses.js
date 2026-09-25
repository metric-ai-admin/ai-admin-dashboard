#!/usr/bin/env node
//
// Are "Work Done" and "Ready to Bill" reachable at all?
//
//   node scripts/probe-billable-statuses.js
//
// READ-ONLY. POSTs that AppFolio treats as reads; nothing is written, stored or
// registered. Run on Render Shell where the AppFolio credentials live — this
// script never asks for a credential and never prints one.
//
// WHERE THIS STANDS
//
// work_order_billable_detail is reachable, carries all eight columns we need,
// ignores every date-filter spelling, and returns nothing at all unless
// work_order_statuses is supplied. Codes 1..12 were swept and only 4 (Completed)
// came back with rows. Work Done and Ready to Bill are the two that matter most
// — they are the UNBILLED pending work the report exists to surface — so before
// accepting a manual-upload design, three things are worth ruling out:
//
//   1. The codes are simply higher. Cheap to test: sweep 13..30.
//
//   2. The parameter has another name. work_order_statuses is what work_order
//      takes; this report may want work_order_status_id, status_ids, or the
//      singular. A wrong filter NAME on this account does not reliably error —
//      it gets ignored — so each candidate is judged by whether the row count
//      CHANGES, not by whether it 200s.
//
//   3. THEY ARE NOT WORK-ORDER STATUSES AT ALL. This is the possibility worth
//      taking seriously. "Completed" is a work-order status; "Work Done" and
//      "Ready to Bill" read like stages of BILLING, which is a different
//      dimension of the same row. If so, no work_order_statuses code will ever
//      produce them, and the filter we want is something like billing_status.
//      Sweeping codes forever would never find that out.
//
// The decisive test is section 1: ask for codes 1..30 in ONE request and print
// every distinct value of the status column that comes back. That is the entire
// universe of statuses this credential can see through this report, in one
// call, and it does not depend on guessing a single code correctly.

require('dotenv').config();

const SUBDOMAIN = process.env.APPFOLIO_SUBDOMAIN || 'metricpropertymanagement';
const CLIENT_ID = process.env.APPFOLIO_CLIENT_ID;
const SECRET = process.env.APPFOLIO_CLIENT_SECRET;

if (!CLIENT_ID || !SECRET) {
  console.error('APPFOLIO_CLIENT_ID / APPFOLIO_CLIENT_SECRET are not set in this shell.');
  console.error('Run this on Render Shell for the dashboard service, where they are configured.');
  process.exit(2);
}

const AUTH = 'Basic ' + Buffer.from(`${CLIENT_ID}:${SECRET}`).toString('base64');
const HOST = `https://${SUBDOMAIN}.appfolio.com`;
const REPORT = 'work_order_billable_detail';
const pause = () => new Promise(r => setTimeout(r, 2300));   // 7 req / 15s limit

// Established by the previous run.
const BASELINE_CODE = ['4'];

async function call(body) {
  let res, text = '';
  try {
    res = await fetch(`${HOST}/api/v2/reports/${REPORT}.json`, {
      method: 'POST',
      headers: { Authorization: AUTH, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      redirect: 'manual',
    });
    text = await res.text();
  } catch (e) { return { error: e.code || e.message, rows: null }; }
  let json = null;
  try { json = JSON.parse(text); } catch {}
  const rows = json && (Array.isArray(json) ? json : json.results || json.rows || json.data);
  return {
    status: res.status,
    rows: Array.isArray(rows) ? rows : null,
    nextPage: !!(json && (json.next_page_url || json.nextPageUrl)),
    snippet: text.replace(/\s+/g, ' ').slice(0, 160),
  };
}

let STATUS_KEY = null;
const statusesIn = rows => {
  if (!rows || !rows.length) return [];
  if (!STATUS_KEY) {
    const k = Object.keys(rows[0]);
    STATUS_KEY = k.find(x => /work_order_status/i.test(x)) || k.find(x => /status/i.test(x)) || null;
  }
  return STATUS_KEY ? [...new Set(rows.map(r => r[STATUS_KEY]).filter(Boolean))].sort() : [];
};

(async () => {
  console.log(`${REPORT} — can Work Done / Ready to Bill be reached?   ${HOST}`);
  console.log('READ-ONLY. Only the status column\'s values are printed.\n');

  console.log('=== 1. THE DECISIVE ONE: every code at once ========================');
  console.log('    Codes 1..30 in a single request. Whatever status values come back');
  console.log('    are the whole universe this credential can see through this report.\n');
  const all = Array.from({ length: 30 }, (_, i) => String(i + 1));
  const wide = await call({ work_order_statuses: all });
  if (wide.error) console.log('  NETWORK', wide.error);
  else {
    const rows = wide.rows || [];
    console.log(`  status ${wide.status}   rows=${rows.length}${wide.nextPage ? '  (MORE PAGES)' : ''}`);
    const vals = statusesIn(rows);
    console.log(`  status column: ${STATUS_KEY || '(not found)'}`);
    console.log('  distinct values visible:');
    vals.forEach(v => console.log(`    - ${v}`));
    const want = ['work done', 'ready to bill'];
    want.forEach(w => {
      const hit = vals.find(v => String(v).toLowerCase().includes(w));
      console.log(`  ${hit ? 'FOUND  ' : 'ABSENT '} "${w}"${hit ? ' -> ' + hit : ''}`);
    });
  }
  await pause();

  console.log('\n=== 2. Codes 13..30, individually =================================');
  console.log('    Only to learn WHICH code carries a value section 1 revealed.\n');
  for (let code = 13; code <= 30; code++) {
    const r = await call({ work_order_statuses: [String(code)] });
    const rows = r.rows || [];
    if (rows.length) console.log(`  code ${String(code).padStart(2)}  ${String(rows.length).padStart(5)} rows  ${statusesIn(rows).join(' | ')}`);
    else console.log(`  code ${String(code).padStart(2)}      0 rows`);
    await pause();
  }

  console.log('\n=== 3. Other names for the status parameter =======================');
  console.log('    Judged by whether the count CHANGES from the code-4 baseline —');
  console.log('    a wrong filter name on this account is ignored, not rejected.\n');
  const base = await call({ work_order_statuses: BASELINE_CODE });
  const baseN = base.rows ? base.rows.length : null;
  console.log(`  baseline work_order_statuses:['4'] = ${baseN} rows\n`);
  await pause();

  const NAME_CANDIDATES = [
    ['work_order_status_id', ['4']],
    ['work_order_status_ids', ['4']],
    ['work_order_status', ['Completed']],
    ['status_ids', ['4']],
    ['statuses', ['Completed']],
    ['work_order_statuses', ['Completed']],          // labels on the known key
  ];
  for (const [key, val] of NAME_CANDIDATES) {
    const r = await call({ [key]: val });
    const n = r.rows ? r.rows.length : null;
    const verdict = n === null ? `status ${r.status}`
      : n === 0 ? 'empty — name not read as a filter, and no default'
        : n === baseN ? 'same count as baseline (inconclusive)'
          : 'DIFFERENT COUNT — this name is read';
    console.log(`  ${(key + ': ' + JSON.stringify(val)).padEnd(46)} rows=${String(n === null ? '?' : n).padStart(5)}  ${verdict}`);
    await pause();
  }

  console.log('\n=== 4. Is it a BILLING dimension, not a work-order status? =========');
  console.log('    "Completed" is a work-order status. "Work Done" and "Ready to Bill"');
  console.log('    read like billing stages — a different field on the same row.\n');
  const DIMENSIONS = [
    ['billing_status', ['Ready to Bill']],
    ['billing_statuses', ['Ready to Bill']],
    ['billable_status', ['Ready to Bill']],
    ['billable_statuses', ['Work Done', 'Ready to Bill', 'Completed']],
    ['labor_statuses', ['Work Done', 'Ready to Bill', 'Completed']],
    ['work_order_labor_statuses', ['Work Done', 'Ready to Bill', 'Completed']],
  ];
  for (const [key, val] of DIMENSIONS) {
    // Sent WITH the known-good status filter, so a change is attributable to
    // this key rather than to the report going empty for lack of statuses.
    const r = await call({ work_order_statuses: BASELINE_CODE, [key]: val });
    const n = r.rows ? r.rows.length : null;
    console.log(`  ${(key + ' + code 4').padEnd(46)} rows=${String(n === null ? '?' : n).padStart(5)}  ${
      n === null ? `status ${r.status}` : n === baseN ? 'unchanged (ignored)' : 'CHANGED — this key is read'}`);
    await pause();
  }

  console.log('\n=== 5. What billing-ish columns does a row already carry? =========');
  // If the distinction is IN the rows we can already pull, no filter is needed:
  // we would fetch Completed and split locally on this column.
  const rows = (base.rows || []);
  if (!rows.length) { console.log('  no baseline rows to inspect'); return; }
  const cols = [...new Set(rows.flatMap(r => Object.keys(r)))]
    .filter(k => /bill|status|paid|invoice|posted/i.test(k)).sort();
  cols.forEach(k => {
    const vals = [...new Set(rows.map(r => r[k]).filter(v => v !== null && v !== ''))];
    const show = vals.slice(0, 8).map(v => (typeof v === 'string' ? v : typeof v)).join(' | ');
    console.log(`  ${k.padEnd(34)} ${String(vals.length).padStart(4)} distinct  ${show}${vals.length > 8 ? ' …' : ''}`);
  });
  console.log('\n  If one of these separates billed from unbilled, the two missing');
  console.log('  statuses may not be needed as a FILTER at all — the distinction');
  console.log('  would already be in the rows we can pull.');
})().catch(e => { console.error('\nprobe failed:', e.message); process.exitCode = 1; });
