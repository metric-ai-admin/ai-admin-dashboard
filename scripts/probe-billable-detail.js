#!/usr/bin/env node
//
// work_order_billable_detail — why does it answer 200 with no rows?
//
//   node scripts/probe-billable-detail.js
//
// READ-ONLY. POSTs that AppFolio treats as reads; nothing is written, stored or
// registered. Run on Render Shell where the AppFolio credentials live — this
// script never asks for a credential and never prints one.
//
// WHERE THIS STANDS
//
// The report EXISTS: /api/v2/reports/work_order_billable_detail.json answered
// 200. Every date window then returned 0 rows, on every parameter spelling.
// That result is not evidence about the dates. Zero rows for ALL of them is the
// signature of something upstream of the filter, and there are four candidates
// worth separating before anyone concludes the data is not there:
//
//   1. MY OWN PROBE WAS WRONG. The first version sent ?paginate_results=false.
//      appfolio-client.js:200 says in as many words that we do NOT use that
//      parameter because AppFolio CAPS it — the supported path is following
//      next_page_url. A capped or rejected pagination mode returning an empty
//      first page would produce exactly what was seen, on every window, which
//      is the pattern here. This version does not send it. That makes this the
//      first thing to rule out, and the most likely.
//
//   2. THE ENVELOPE IS NOT WHAT WE ASSUME. The client expects
//      { results: [...], next_page_url }. If this report answers with a
//      different shape, "0 rows" is a misread of a populated response rather
//      than an empty one. So the raw top-level keys are printed on every call.
//
//   3. A REQUIRED FILTER IS MISSING. work_order_labor_summary returns nothing
//      useful without labor_performed_from/to; a report that needs an entity or
//      status selection may answer 200 with an empty set rather than an error.
//
//   4. THE WINDOW GENUINELY HAD NO BILLABLE WORK. Possible — but note that
//      "54 graded calls on 2026-09-22" is about phone calls, not work orders,
//      and says nothing about whether any labor was performed or billed that
//      day. This probe widens to 30 and 90 days so an empty result has to
//      survive a window where the business certainly did billable work.
//
// Column VALUES are not printed. Names, types and counts answer the question;
// the rows carry vendor and cost detail with no reason to sit in a terminal log.

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

// NOTE: no paginate_results. See candidate 1 above.
async function call(body, { report = REPORT } = {}) {
  const url = `${HOST}/api/v2/reports/${report}.json`;
  let res, text = '';
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: AUTH, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      redirect: 'manual',
    });
    text = await res.text();
  } catch (e) { return { error: e.code || e.message }; }

  let json = null;
  try { json = JSON.parse(text); } catch {}
  const rows = json && (Array.isArray(json) ? json : json.results || json.rows || json.data);
  return {
    status: res.status,
    json,
    // Every top-level key, so an unexpected envelope is visible rather than
    // silently read as empty.
    keys: json && !Array.isArray(json) ? Object.keys(json) : Array.isArray(json) ? ['(bare array)'] : [],
    rows: Array.isArray(rows) ? rows : null,
    nextPage: json && (json.next_page_url || json.nextPageUrl) ? 'yes' : 'no',
    snippet: text.replace(/\s+/g, ' ').slice(0, 200),
  };
}

function line(label, r) {
  if (r.error) return console.log(`  ${label.padEnd(46)} NETWORK ${r.error}`);
  const n = r.rows ? r.rows.length : null;
  console.log(`  ${label.padEnd(46)} ${String(r.status).padEnd(4)} rows=${String(n === null ? '?' : n).padStart(5)}  next_page=${r.nextPage}  keys=[${r.keys.join(',')}]`);
  if (n === null && r.snippet) console.log(`  ${''.padEnd(46)} body: ${r.snippet.slice(0, 140)}`);
}

(async () => {
  console.log(`${REPORT} — why 200 with no rows?   ${HOST}`);
  console.log('READ-ONLY. No paginate_results this time (see header).\n');

  console.log('=== 1. No filters at all ===========================================');
  console.log('    If this returns rows, the report is fine and a FILTER emptied it.');
  console.log('    If this is also empty, the filters were never the problem.\n');
  const bare = await call({});
  line('no params', bare);
  if (bare.json && !bare.rows) {
    console.log('\n  Unrecognised envelope. Full top-level shape:');
    console.log('  ' + JSON.stringify(bare.json).slice(0, 500));
  }
  await pause();

  console.log('\n=== 2. Windows that certainly contain billable work ================');
  // "54 graded calls on 2026-09-22" is about phone calls, not work orders — it
  // is not evidence of billable labor. 30 and 90 days are here so an empty
  // result has to survive a window the business cannot have been idle through.
  const WINDOWS = [
    ['1 day  2026-09-22', '2026-09-22', '2026-09-22'],
    ['7 days 09-19..09-25', '2026-09-19', '2026-09-25'],
    ['30 days 08-26..09-25', '2026-08-26', '2026-09-25'],
    ['90 days 06-27..09-25', '2026-06-27', '2026-09-25'],
  ];
  const PARAMS = [
    ['labor_performed_from', 'labor_performed_to'],
    ['work_done_from', 'work_done_to'],
    ['status_date_from', 'status_date_to'],
    ['from_date', 'to_date'],
  ];
  const counts = {};
  for (const [from, to] of PARAMS) {
    console.log(`\n  --- ${from} / ${to}`);
    for (const [label, a, b] of WINDOWS) {
      const r = await call({ [from]: a, [to]: b });
      line(label, r);
      counts[`${from}|${label}`] = r.rows ? r.rows.length : null;
      await pause();
    }
  }

  console.log('\n=== 3. Date FORMAT ================================================');
  // ISO works for work_order_labor_summary on this account, so this is a long
  // shot — but it costs two requests and would explain a silent empty set.
  for (const [from, to] of [['labor_performed_from', 'labor_performed_to']]) {
    line('US format 08/26/2026-09/25/2026',
      await call({ [from]: '08/26/2026', [to]: '09/25/2026' }));
    await pause();
  }

  console.log('\n=== 4. Status filter, both spellings ==============================');
  // The UI restricts to Work Done / Ready to Bill / Completed. work_order takes
  // NUMERIC codes under work_order_statuses; the label spelling is tried too.
  const W30 = { labor_performed_from: '2026-08-26', labor_performed_to: '2026-09-25' };
  line('statuses as labels', await call({ ...W30, work_order_statuses: ['Work Done', 'Ready to Bill', 'Completed'] }));
  await pause();
  line('statuses as codes', await call({ ...W30, work_order_statuses: ['4', '7'] }));
  await pause();
  line('no window, labels only', await call({ work_order_statuses: ['Work Done', 'Ready to Bill', 'Completed'] }));
  await pause();

  console.log('\n=== 5. Control: a report we KNOW returns rows ======================');
  // Proves the credentials and this request shape are good, so an empty result
  // above is about THIS report and not about how the probe is calling.
  line('work_order_labor_summary 30d', await call(
    { labor_performed_from: '2026-08-26', labor_performed_to: '2026-09-25' },
    { report: 'work_order_labor_summary' }));
  await pause();
  line('work_order (no params)', await call({}, { report: 'work_order' }));

  console.log('\n=== 6. Columns, from whichever call returned the most rows =========');
  // Re-run the widest window and read the schema off it.
  const best = await call({ labor_performed_from: '2026-06-27', labor_performed_to: '2026-09-25' });
  const probe = best.rows && best.rows.length ? best.rows : (bare.rows || []);
  if (!probe.length) {
    console.log('  Still no rows, so the column list is unknown.');
    console.log('  Read section 1 first: if the unfiltered call is also empty, the report');
    console.log('  is reachable but returns nothing to this credential — which points at');
    console.log('  entity/property scope on the API user, not at the date parameters.');
    return;
  }
  // Union across rows: AppFolio omits empty columns per row, so the first row
  // alone under-reports the schema.
  const cols = new Map();
  probe.slice(0, 200).forEach(row => Object.entries(row).forEach(([k, v]) => {
    if (!cols.has(k)) cols.set(k, new Set());
    if (v !== null && v !== '') cols.get(k).add(typeof v);
  }));
  console.log(`  ${probe.length} row(s); ${cols.size} column(s):\n`);
  [...cols.keys()].sort().forEach(k => console.log(`    ${k.padEnd(38)} ${[...cols.get(k)].join('|') || '(always empty)'}`));

  console.log('\n=== 7. Do we get what we need? ====================================');
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
  console.log('\n  Date filter verdict — compare these counts:');
  Object.entries(counts).forEach(([k, v]) => { if (v) console.log(`    ${k}: ${v}`); });
  console.log('    Different counts across windows for one parameter pair = filter IS read.');
  console.log('    Identical non-zero counts = filter ignored; we would window locally.');
})().catch(e => { console.error('\nprobe failed:', e.message); process.exitCode = 1; });
