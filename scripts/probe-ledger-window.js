#!/usr/bin/env node
//
// Can tenant_ledger answer "was the FAS processed" and "was the refund paid"?
// READ ONLY. PATTERNS AND COUNTS ONLY — never a description as written.
//
//   node scripts/probe-ledger-window.js
//   node scripts/probe-ledger-window.js --days 90
//
// WHY THE MASKING IS NOT OPTIONAL. The previous probe printed two resident
// names under a banner saying no name was printed. AppFolio interpolates the
// resident, the property and the unit INTO the description —
//
//   "Resident Security Deposits - <resident>, <property> - <unit>: Transfer
//    of Resident Security Deposits at Move Out"
//
// — and I treated the field as a system label because that is what a ledger
// description usually is. Everything printed here goes through
// lib/ledger-mask.js, which patterns it and then checks what is left against
// names from our own data.
//
// THE DATE PARAMETER IS DISCOVERED, NOT ASSUMED. The applications sync spent a
// morning on this: `from_date` was accepted, ignored, and returned 20 rows that
// looked like a working filter. So every candidate is compared against an
// UNFILTERED baseline, and a parameter that returns the same row count is
// reported as IGNORED rather than working.
require('dotenv').config();

const ID = process.env.APPFOLIO_REPORTS_CLIENT_ID;
const SECRET = process.env.APPFOLIO_REPORTS_CLIENT_SECRET;
const HOST = process.env.APPFOLIO_REPORTS_HOST || 'metricpropertymanagement.appfolio.com';

const MASK = require('../lib/ledger-mask.js');
const WEEK = require('../lib/week.js');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const DAYS = Number(arg('days', 90));
const TODAY = WEEK.todayYMD();
const FROM = WEEK.addDaysYMD(TODAY, -DAYS);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = (s, w) => String(s).padEnd(w);

async function report(params) {
  const r = await global.fetch('https://' + HOST + '/api/v2/reports/tenant_ledger.json', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(ID + ':' + SECRET).toString('base64'),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ paginate_results: false, ...params }),
  });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch (e) { /* not json */ }
  const rows = Array.isArray(j) ? j : ((j && (j.results || j.data)) || []);
  return { status: r.status, rows };
}

// Date-parameter candidates, in the shapes AppFolio has actually used on the
// reports we already drive: applications took received_on_from/_to, the work
// orders took status_date_range_from/_to.
const DATE_PARAMS = [
  ['from_date', 'to_date'],
  ['date_from', 'date_to'],
  ['posted_on_from', 'posted_on_to'],
  ['posted_from', 'posted_to'],
  ['transaction_date_from', 'transaction_date_to'],
  ['date_range_from', 'date_range_to'],
  ['start_date', 'end_date'],
  ['as_of_from', 'as_of_to'],
];

const MOVEOUT_RE = /transfer of resident security deposits at move ?out/i;
const SETTLE_RE = /settlement for unpaid resident security deposits/i;
const REFUND_RE = /refund|check\b|returned|disburse|payout|reimburse/i;
const FAS_RE = /final account|statement/i;

(async () => {
  if (!ID || !SECRET) {
    console.error('APPFOLIO_REPORTS_CLIENT_ID / _SECRET are not set in this shell. Run on Render.');
    process.exitCode = 1;
    return;
  }

  // Names from our own data, for the verifying layer of the mask.
  const af = require('../appfolio-reports.js');
  const store = async id => (((await af.readReportData(id)) || {}).rows) || [];
  const turns = await store('unit_turn_detail');
  const tickler = await store('tenant_tickler');
  const known = [];
  [...turns, ...tickler].forEach(r => {
    ['tenant', 'tenant_name', 'primary_tenant', 'resident', 'property_name', 'property']
      .forEach(k => { if (r[k]) known.push(String(r[k])); });
  });
  console.log('mask vocabulary: ' + new Set(known).size + ' names and properties from our own data\n');

  // ---- 1. the baseline -----------------------------------------------------
  const base = await report({});
  console.log('BASELINE (no parameters): ' + base.rows.length + ' rows');
  const dates = base.rows.map(r => String(r.date || '').slice(0, 10)).filter(Boolean).sort();
  console.log('   date range in the response: ' + (dates[0] || '—') + ' .. ' + (dates[dates.length - 1] || '—'));
  console.log('   columns: ' + (base.rows[0] ? Object.keys(base.rows[0]).join(', ') : '—'));

  // ---- 2. which date parameter actually filters ---------------------------
  console.log('\nWHICH DATE PARAMETER IS HONOURED (' + FROM + ' .. ' + TODAY + ')');
  console.log('   A parameter that returns the baseline count is IGNORED, not working.');
  let working = null;
  for (const [a, b] of DATE_PARAMS) {
    const r = await report({ [a]: FROM, [b]: TODAY });
    const same = r.rows.length === base.rows.length;
    const verdict = r.status >= 400 ? 'REJECTED'
      : (same ? 'IGNORED (same count as baseline)' : 'FILTERS — ' + r.rows.length + ' rows');
    console.log('   ' + pad(a + ' / ' + b, 46) + verdict);
    if (r.status < 400 && !same && !working) working = { a, b, rows: r.rows };
    await sleep(600);
  }

  const rows = working ? working.rows : base.rows;
  if (!working) {
    console.log('\n   NONE of them filtered. Everything below is the baseline window —');
    console.log('   which looked like the current month only, so a 90-day question');
    console.log('   cannot be answered from this report without another parameter.');
  } else {
    console.log('\n   Using ' + working.a + ' / ' + working.b + ': ' + rows.length + ' rows');
  }

  // ---- 3. what kinds of entry exist ---------------------------------------
  const t = MASK.tally(rows, 'description', known);
  console.log('\nENTRY PATTERNS (' + t.rows.length + ' distinct, over ' + rows.length + ' rows)');
  if (t.withheld) {
    console.log('   ' + t.withheld + ' rows withheld entirely: the pattern still contained a');
    console.log('   name from our data, so it is counted and not shown.');
  }
  t.rows.slice(0, 30).forEach(x => console.log('   ' + pad(x.count, 7) + x.pattern));

  // ---- 4. the move-out entries --------------------------------------------
  const moveOutRows = rows.filter(r => MOVEOUT_RE.test(String(r.description || '')));
  const settleRows = rows.filter(r => SETTLE_RE.test(String(r.description || '')));
  const refundRows = rows.filter(r => REFUND_RE.test(String(r.description || '')));
  const fasRows = rows.filter(r => FAS_RE.test(String(r.description || '')));

  console.log('\nTHE ENTRIES THAT WOULD CARRY THE ANSWER');
  console.log('   ' + pad('Transfer ... at Move Out', 44) + moveOutRows.length);
  console.log('   ' + pad('Settlement for unpaid ... Deposits', 44) + settleRows.length);
  console.log('   ' + pad('anything mentioning refund/check/returned', 44) + refundRows.length);
  console.log('   ' + pad('anything mentioning final account/statement', 44) + fasRows.length);

  // ---- 5. can they be tied to a move-out ----------------------------------
  //
  // By PROPERTY + UNIT read out of the description, never by the name. The
  // pair is enough to join and carries nobody's identity on its own.
  const unitOf = s => {
    const m = String(s || '').match(/,\s*([^,]+?)\s*-\s*([A-Za-z0-9-]+)\s*:/);
    return m ? { property: m[1].trim(), unit: m[2].trim() } : null;
  };
  const turnKeys = new Set();
  turns.forEach(x => {
    const p = String(x.property_name || x.property || '').trim().toLowerCase();
    const u = String(x.unit || x.unit_name || '').trim().toLowerCase();
    if (p && u) turnKeys.add(p + '|' + u);
  });

  let parsed = 0;
  let matched = 0;
  moveOutRows.concat(settleRows).forEach(r => {
    const k = unitOf(r.description);
    if (!k) return;
    parsed++;
    if (turnKeys.has(k.property.toLowerCase() + '|' + k.unit.toLowerCase())) matched++;
  });
  const total = moveOutRows.length + settleRows.length;
  console.log('\n   of those ' + total + ' deposit entries:');
  console.log('      property+unit readable from the text : ' + parsed);
  console.log('      and matching a row in unit_turn_detail: ' + matched);
  if (total && !parsed) {
    console.log('      The text does not follow the shape the parser expects, so the');
    console.log('      join would have to come from a column rather than from prose.');
  }

  console.log('\nNothing was written. No description was printed as written, and no');
  console.log('amount, payer, date or unit of any single row was printed.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
