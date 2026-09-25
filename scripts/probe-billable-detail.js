#!/usr/bin/env node
//
// work_order_billable_detail — status code mapping, columns, and whether the
// date filter is read once a status filter is present.
//
//   node scripts/probe-billable-detail.js
//
// READ-ONLY. POSTs that AppFolio treats as reads; nothing is written, stored or
// registered. Run on Render Shell where the AppFolio credentials live — this
// script never asks for a credential and never prints one.
//
// WHAT THE LAST RUN ACTUALLY SHOWED
//
// The report answered 200 but returned 0 rows for every date window with NO
// status filter, and 759 rows for `work_order_statuses: ['4','7']` — which in
// that same run was sent WITH the 30-day window (2026-08-26..2026-09-25), not
// without it. So two conclusions people could reasonably draw from "759 rows"
// are not yet supported:
//
//   "the date filter is ignored"   — it was never tested with a status filter
//                                    present. Dates alone returned nothing
//                                    because the report returns nothing without
//                                    statuses; that says nothing about whether
//                                    the dates were read.
//   "759 rows is all time"         — that call carried a 30-day window. All-time
//                                    has not been measured.
//
// Section 2 settles it by holding the statuses constant and varying only the
// window. If the counts differ, the date filter works and we should let
// AppFolio do the filtering rather than pulling everything and windowing in our
// own code.
//
// AND THE CODES ARE NOT THE ONES WE WANT
//
// 4 and 7 came from work_order, where they mean Completed and Completed No Need
// To Bill. The UI report selects Work Done, Ready to Bill and Completed. Those
// first two have no known code — 759 rows is a pull MISSING two of the three
// statuses the report is supposed to carry. Section 1 recovers the mapping from
// the data instead of guessing: each code is requested alone, and the status
// column of the rows that come back says what that code means.
//
// Column VALUES are not printed, with one exception: the status column, because
// its values ARE the mapping being recovered. It carries no resident data.

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

const WANTED = ['Vendor', 'Billable Type', 'Amount', 'Worked Hours', 'Billable Hours',
  'Work Order Status', 'Billed Amount', 'Unbilled Amount'];
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

async function call(body) {
  const url = `${HOST}/api/v2/reports/${REPORT}.json`;
  let res, text = '';
  try {
    res = await fetch(url, {
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
    // A count at the page cap means the real total is larger and this is one
    // page, not the answer.
    nextPage: !!(json && (json.next_page_url || json.nextPageUrl)),
    snippet: text.replace(/\s+/g, ' ').slice(0, 160),
  };
}

// Whichever key actually holds the status text; found once, reused.
let STATUS_KEY = null;
function findStatusKey(row) {
  const keys = Object.keys(row);
  return keys.find(k => /work_order_status/i.test(k))
    || keys.find(k => /(^|_)status($|_)/i.test(k))
    || keys.find(k => /status/i.test(k))
    || null;
}

(async () => {
  console.log(`${REPORT} — status mapping and columns   ${HOST}`);
  console.log('READ-ONLY. No row values printed except the status column.\n');

  console.log('=== 1. What does each numeric status code MEAN? ====================');
  console.log('    Each code requested alone; the status column of the rows says what');
  console.log('    it is. 4 and 7 are borrowed from work_order (Completed, Completed');
  console.log('    No Need To Bill) — Work Done and Ready to Bill have no known code.\n');
  const mapping = {};
  for (let code = 1; code <= 12; code++) {
    const r = await call({ work_order_statuses: [String(code)] });
    if (r.error) { console.log(`  code ${String(code).padStart(2)}  NETWORK ${r.error}`); await pause(); continue; }
    const rows = r.rows || [];
    let label = '(no rows — code may be unused or invalid)';
    if (rows.length) {
      if (!STATUS_KEY) STATUS_KEY = findStatusKey(rows[0]);
      const vals = STATUS_KEY ? [...new Set(rows.map(x => x[STATUS_KEY]).filter(Boolean))] : [];
      label = vals.length ? vals.join(' | ') : '(rows returned, no status column found)';
    }
    console.log(`  code ${String(code).padStart(2)}  ${String(rows.length).padStart(5)} rows  ${label}`);
    if (rows.length) mapping[code] = label;
    await pause();
  }
  console.log('\n  MAPPING RECOVERED');
  Object.entries(mapping).forEach(([c, l]) => console.log(`    ${String(c).padStart(2)} = ${l}`));
  const wanted3 = Object.entries(mapping)
    .filter(([, l]) => /work done|ready to bill|^completed$/i.test(String(l).trim()))
    .map(([c]) => c);
  console.log(`  Codes matching the UI's Work Done / Ready to Bill / Completed: ${wanted3.length ? wanted3.join(', ') : 'NONE FOUND — read the list above and pick by hand'}`);

  // Everything below holds the statuses constant so only one thing varies.
  const CODES = wanted3.length ? wanted3 : ['4', '7'];
  console.log(`\n  Using codes [${CODES.join(', ')}] for the rest of this run.`);

  console.log('\n=== 2. IS the date filter read? ====================================');
  console.log('    Statuses held constant, only the window changes. Dates alone returned');
  console.log('    0 rows last time because the report needs statuses — that was never');
  console.log('    a test of the dates.\n');
  const WINDOWS = [
    ['no window at all', null],
    ['1 day   2026-09-22', ['2026-09-22', '2026-09-22']],
    ['7 days  09-19..09-25', ['2026-09-19', '2026-09-25']],
    ['30 days 08-26..09-25', ['2026-08-26', '2026-09-25']],
    ['90 days 06-27..09-25', ['2026-06-27', '2026-09-25']],
  ];
  const PAIRS = [['labor_performed_from', 'labor_performed_to'], ['work_done_from', 'work_done_to']];
  for (const [from, to] of PAIRS) {
    console.log(`  --- ${from} / ${to}`);
    const seen = [];
    for (const [label, w] of WINDOWS) {
      const body = { work_order_statuses: CODES };
      if (w) { body[from] = w[0]; body[to] = w[1]; }
      const r = await call(body);
      const n = r.rows ? r.rows.length : null;
      seen.push(n);
      console.log(`    ${label.padEnd(24)} rows=${String(n === null ? '?' : n).padStart(5)}${r.nextPage ? '  (MORE PAGES — this is one page, not the total)' : ''}`);
      await pause();
    }
    const real = seen.filter(x => x !== null);
    const varies = new Set(real).size > 1;
    console.log(`    -> ${varies ? 'DATE FILTER IS READ — let AppFolio do the filtering'
      : 'every window identical: filter IGNORED — we would window locally'}\n`);
  }

  console.log('=== 3. Columns ====================================================');
  const full = await call({ work_order_statuses: CODES });
  const rows = full.rows || [];
  if (!rows.length) { console.log('  No rows — cannot read the schema.'); return; }
  console.log(`  ${rows.length} row(s)${full.nextPage ? ' on this page, MORE PAGES EXIST' : ''}\n`);
  // Union across rows: AppFolio omits empty columns per row, so the first row
  // alone under-reports the schema.
  const cols = new Map();
  rows.slice(0, 300).forEach(row => Object.entries(row).forEach(([k, v]) => {
    if (!cols.has(k)) cols.set(k, new Set());
    if (v !== null && v !== '') cols.get(k).add(typeof v);
  }));
  console.log(`  ${cols.size} column(s):\n`);
  [...cols.keys()].sort().forEach(k => console.log(`    ${k.padEnd(40)} ${[...cols.get(k)].join('|') || '(always empty)'}`));

  console.log('\n=== 4. Do we get the eight columns we need? ========================');
  const have = new Set([...cols.keys()].map(norm));
  let missing = 0;
  WANTED.forEach(w => {
    const n = norm(w);
    const exact = have.has(n);
    const near = !exact && [...have].find(h => h.includes(n) || n.includes(h));
    console.log(`  ${exact ? 'yes ' : near ? 'near' : 'NO  '}  ${w.padEnd(20)}${exact ? '' : near ? ' -> ' + near : ''}`);
    if (!exact && !near) missing++;
  });
  console.log(`\n  ${WANTED.length - missing} of ${WANTED.length} needed columns present.`);

  console.log('\n=== 5. Which column is the "Work Done On" date? ====================');
  // The three views differ only by this date, so knowing which column carries
  // it is what makes local windowing possible if the API filter turns out dead.
  const dateCols = [...cols.keys()].filter(k => /date|_on$|performed|completed/i.test(k));
  console.log(`  date-ish columns: ${dateCols.length ? dateCols.join(', ') : '(none found)'}`);
  dateCols.forEach(k => {
    const vals = rows.map(r => r[k]).filter(Boolean).map(String).sort();
    if (vals.length) console.log(`    ${k.padEnd(30)} ${vals.length} populated, range ${vals[0].slice(0, 10)} .. ${vals[vals.length - 1].slice(0, 10)}`);
    else console.log(`    ${k.padEnd(30)} always empty`);
  });
})().catch(e => { console.error('\nprobe failed:', e.message); process.exitCode = 1; });
