#!/usr/bin/env node
//
// Is "Work Order Billable Detail" reachable as a BASE report?
//
//   node scripts/probe-billable-detail.js
//
// READ-ONLY. POSTs that AppFolio treats as reads; nothing is written, stored or
// registered. Run on Render Shell where the AppFolio credentials live — this
// script never asks for a credential and never prints one.
//
// WHY THIS IS THE RIGHT QUESTION
//
// The three saved reports (MDaily/MWeekly/MMonthly) are all views of one report
// named "Work Order Billable Detail". Their UUIDs answer 400 through the API
// and their buffered_reports pages want a login session. But the Move Out
// Directory went exactly the same way and is synced today: the saved view was
// unreachable while the BASE report (tenant_tickler) answered fine. If the base
// report here is reachable, the three views are filters and date ranges we can
// reproduce locally rather than endpoints we need to fetch.
//
// TWO UNKNOWNS, PROBED SEPARATELY
//
// 1. The report NAME. The UI label is "Work Order Billable Detail"; the API
//    wants the underlying resource name, and those are not always the obvious
//    snake_case of the label. work_order_labor_detail looked just as plausible
//    and answers 400 — it does not exist (appfolio-reports.js:109). So several
//    candidates are tried and a 400 is treated as information, not failure.
//
// 2. The DATE PARAMETER names. The request asks for from_date/to_date, but the
//    labor summary on this same account requires labor_performed_from /
//    labor_performed_to, and a wrong filter name is not always an error —
//    `status: 'Completed'` was silently IGNORED on work_order and returned a
//    full unfiltered pull that looked like a successful filter. So each name
//    pair is sent AND the returned row count is compared between a one-day and
//    a seven-day window. If the filter is being read, the counts differ. If
//    they are identical, the filter is being ignored and any date range we
//    think we are sending is fiction.
//
// Column VALUES are not printed. Column names, types and row counts answer the
// question; the rows carry vendor and cost detail that has no reason to sit in
// a terminal log.

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

// Asked for by name first; the rest are the near-misses worth ruling out in the
// same run, since each one costs a single request against a 7-per-15s limit.
const NAMES = [
  'work_order_billable_detail',
  'work_order_billable',
  'billable_detail',
  'work_order_billing_detail',
  'work_order_billable_summary',
];

const DATE_PARAMS = [
  ['from_date', 'to_date'],
  ['labor_performed_from', 'labor_performed_to'],   // what the labor summary requires
  ['billable_from', 'billable_to'],
];

const ONE_DAY = ['2026-09-25', '2026-09-25'];
const ONE_WEEK = ['2026-09-19', '2026-09-25'];

// What we need the report to carry, per the ask.
const WANTED = ['Vendor', 'Billable Type', 'Amount', 'Worked Hours', 'Billable Hours',
  'Work Order Status', 'Billed Amount', 'Unbilled Amount'];
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

// Be kind to the 7-requests-per-15-seconds limit; a probe that trips it reads
// as a broken endpoint.
const pause = () => new Promise(r => setTimeout(r, 2300));

async function call(report, body) {
  const url = `${HOST}/api/v2/reports/${report}.json?paginate_results=false`;
  let res, text = '';
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: AUTH, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      redirect: 'manual',
    });
    text = await res.text();
  } catch (e) {
    return { error: e.code || e.message };
  }
  let json = null;
  try { json = JSON.parse(text); } catch {}
  const rows = json && (Array.isArray(json) ? json : json.results || json.rows || json.data);
  return {
    status: res.status,
    contentType: (res.headers.get('content-type') || '').split(';')[0],
    isJson: !!json,
    rows: Array.isArray(rows) ? rows : null,
    snippet: text.replace(/\s+/g, ' ').slice(0, 180),
  };
}

(async () => {
  console.log(`Work Order Billable Detail — base-report probe against ${HOST}`);
  console.log('READ-ONLY. Column names and counts only; no row values are printed.\n');

  console.log('=== 1. Does the report name exist? =================================');
  let live = null;
  for (const name of NAMES) {
    const r = await call(name, {});
    if (r.error) { console.log(`  ${name.padEnd(30)} NETWORK ${r.error}`); await pause(); continue; }
    const verdict = r.status === 200 ? 'EXISTS'
      : r.status === 400 ? 'no such report'
        : r.status === 401 || r.status === 403 ? 'AUTH REFUSED'
          : String(r.status);
    console.log(`  ${name.padEnd(30)} ${String(r.status).padEnd(4)} ${verdict}`);
    if (r.status !== 200 && r.snippet) console.log(`  ${''.padEnd(30)}      ${r.snippet.slice(0, 120)}`);
    if (r.status === 200 && !live) live = name;
    await pause();
  }

  if (!live) {
    console.log('\nNone of the candidate names exist. The UI label does not map to a public');
    console.log('report resource, same as work_order_labor_detail. Nothing further to test.');
    return;
  }
  console.log(`\nReachable base report: ${live}`);

  console.log('\n=== 2. Are the date filters actually read? =========================');
  console.log('    (identical row counts for 1 day and 7 days means the filter is IGNORED)');
  let bestParams = null;
  for (const [from, to] of DATE_PARAMS) {
    const a = await call(live, { [from]: ONE_DAY[0], [to]: ONE_DAY[1] });
    await pause();
    const b = await call(live, { [from]: ONE_WEEK[0], [to]: ONE_WEEK[1] });
    await pause();
    const ca = a.rows ? a.rows.length : null;
    const cb = b.rows ? b.rows.length : null;
    const read = ca !== null && cb !== null && ca !== cb;
    console.log(`  ${(from + ' / ' + to).padEnd(44)} 1-day ${String(ca).padStart(5)}   7-day ${String(cb).padStart(5)}   ${
      ca === null || cb === null ? `status ${a.status}/${b.status}` : read ? 'FILTER IS READ' : 'filter ignored (or genuinely equal)'}`);
    if (read && !bestParams) bestParams = { from, to, sample: b.rows };
  }

  console.log('\n=== 3. Columns ====================================================');
  const probe = bestParams ? bestParams.sample : (await call(live, {})).rows;
  if (!probe || !probe.length) {
    console.log('  No rows returned for the window tested, so the column list is unknown.');
    console.log('  Re-run with a range known to contain billable work.');
    return;
  }
  // Union across rows: AppFolio omits empty columns per row, so the first row
  // alone under-reports the schema.
  const cols = new Map();
  probe.slice(0, 200).forEach(row => Object.entries(row).forEach(([k, v]) => {
    if (!cols.has(k)) cols.set(k, new Set());
    if (v !== null && v !== '') cols.get(k).add(typeof v);
  }));
  console.log(`  ${probe.length} row(s); ${cols.size} distinct column(s):\n`);
  [...cols.keys()].sort().forEach(k => console.log(`    ${k.padEnd(38)} ${[...cols.get(k)].join('|') || '(always empty)'}`));

  console.log('\n=== 4. Do we get what we need? ====================================');
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
  if (bestParams) console.log(`  Date filter that works: ${bestParams.from} / ${bestParams.to}`);
  else console.log('  WARNING: no date filter was confirmed to be read. A range we think we are');
  console.log('  sending may be silently ignored, returning everything.');
})().catch(e => { console.error('\nprobe failed:', e.message); process.exitCode = 1; });
