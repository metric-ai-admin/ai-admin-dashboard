#!/usr/bin/env node
//
// Is there a CASH-BASIS collections figure, per property, anywhere in the
// Reports API? READ ONLY — report reads, nothing written anywhere.
//
//   node scripts/probe-cash-basis.js
//   PROBE_PROPERTY_ID=1703 node scripts/probe-cash-basis.js
//
// WHY THIS EXISTS. The dry run on 2026-10-14 showed income_statement is
// reporting BILLED income, not money received. Ascent: 56,336 against 47,301
// of monthly rent, while carrying 16,118 of delinquency — it cannot have
// collected more than it bills with a sixth of it unpaid. accounting_basis is
// ignored like every other parameter, so the basis cannot be changed by asking.
//
// Kara's alert is about money RECEIVED. A month of history captured on the
// wrong basis would look healthy the whole time and then answer the wrong
// question with a confident number, by property, in her 6 AM email.
//
// THE TEST IS ARITHMETIC, NOT NAMING. A report called "cash flow" proves
// nothing. The anchor is:
//
//   billed (income_statement)  minus  what is owed (delinquency)  ~=  received
//
// so a cash-basis source must come back LOWER than income_statement, and lower
// by an amount in the neighbourhood of the delinquency — not lower by 2%, and
// not higher. The verdict compares VALUES. A parameter that is accepted and
// ignored returns a full-looking response with the same numbers in it, which
// is how `from_date` on the applications report cost a morning.
//
// PRIVACY. Receipt and ledger reports carry resident names, unit numbers and
// amounts per line. NOTHING here prints a row. Only column NAMES, row counts
// and column totals leave this script — a probe printed an applicant's email,
// phone, employer and salary on 2026-10-13 and that must not happen again.
require('dotenv').config();

const ID = process.env.APPFOLIO_REPORTS_CLIENT_ID;
const SECRET = process.env.APPFOLIO_REPORTS_CLIENT_SECRET;
const HOST = process.env.APPFOLIO_REPORTS_HOST || 'metricpropertymanagement.appfolio.com';
const PROP = process.env.PROBE_PROPERTY_ID || '1703';   // Ascent
const PROP_NAME = process.env.PROBE_PROPERTY_NAME || 'Ascent';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = (s, w) => String(s).padEnd(w);
const money = n => (n === null || n === undefined ? '—'
  : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }));

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  let s = String(v).trim().replace(/[$,\s]/g, '');
  const neg = /^\(.*\)$/.test(s);
  if (neg) s = s.slice(1, -1);
  const n = Number(s);
  return isFinite(n) ? (neg ? -n : n) : null;
}

async function call(report, body, attempt) {
  const r = await global.fetch('https://' + HOST + '/api/v2/reports/' + report + '.json', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(ID + ':' + SECRET).toString('base64'),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (r.status === 429) {
    const n = (attempt || 0) + 1;
    if (n > 5) return { status: 429, rows: [], note: 'rate limited five times' };
    const wait = Number(r.headers.get('retry-after')) || 30;
    await sleep(wait * 1000);
    return call(report, body, n);
  }
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch (e) { /* not json */ }
  const rows = Array.isArray(j) ? j : ((j && (j.results || j.data)) || []);
  // The error text is the useful part of a failure — "Id is not a valid report"
  // means the name is wrong, a 500 means the name is right and the shape is
  // not. It is a system message with no resident data in it, but it is
  // truncated anyway rather than trusted.
  const err = r.ok ? null : String((j && (j.error || j.message)) || text).slice(0, 120);
  return { status: r.status, rows, err };
}

// Candidate cash-side reports. Nobody has a catalogue — the documented list
// probe came back empty on 2026-10-13 — so this is a sweep of the names
// AppFolio uses elsewhere in its product. An invalid name costs one call and
// answers instantly.
const CANDIDATES = [
  'cash_flow',
  'cash_flow_statement',
  'twelve_month_cash_flow',
  'income_statement_cash',
  'income_statement_detail',
  'general_ledger',
  'gl_transactions',
  'journal_ledger',
  'receipts',
  'receipt_detail',
  'tenant_receipts',
  'payment_detail',
  'payments',
  'deposit_register',
  'bank_deposit_detail',
  'bank_transactions',
  'rent_collection',
  'collections_detail',
  'owner_statement',
  'budget_vs_actual',
  'trust_account_balance',
];

// A money column, found by shape rather than by name. We have been wrong about
// a column name three times this month.
function totals(rows) {
  const sums = {};
  const counts = {};
  (rows || []).forEach(r => {
    Object.entries(r || {}).forEach(([k, v]) => {
      const n = num(v);
      if (n === null) return;
      sums[k] = (sums[k] || 0) + n;
      counts[k] = (counts[k] || 0) + 1;
    });
  });
  return { sums, counts };
}

// The line that reads like rent income, if the report has named lines at all.
function rentLine(rows) {
  const row = (rows || []).find(r =>
    Object.values(r || {}).some(v => /^rent income$/i.test(String(v || '').trim())));
  if (!row) return null;
  const vals = Object.values(row).map(num).filter(n => n !== null && n !== 0);
  return vals.length ? vals[0] : null;
}

(async () => {
  if (!ID || !SECRET) {
    console.error('APPFOLIO_REPORTS_CLIENT_ID / _SECRET are not set here. Run on Render Shell.');
    process.exitCode = 1;
    return;
  }
  console.log('READ ONLY. Report reads only. Nothing is written anywhere.');
  console.log('No row is printed — only column names, counts and column totals.\n');

  const filter = { properties: { properties_ids: [PROP] } };
  const base = { property_visibility: 'active', paginate_results: false };

  // ---- the two anchors ------------------------------------------------------
  console.log('ANCHORS for ' + PROP_NAME + ' (property ' + PROP + ')');

  const inc = await call('income_statement', { ...filter, ...base });
  const billed = rentLine(inc.rows);
  console.log('   income_statement Rent Income   ' + money(billed) + '   (billed — what we have)');
  await sleep(800);

  // What is owed, from the report Collections already uses. If cash is real,
  // the gap between billed and cash should be of this order.
  let owed = null;
  try {
    const dq = await call('delinquency_as_of', { ...filter, ...base, tenant_statuses: ['0', '4'] });
    const t = totals(dq.rows);
    // The biggest positive money column is the balance; named differently in
    // different pulls, so taken by shape.
    const best = Object.entries(t.sums)
      .filter(([k]) => /balance|owed|total|delinq/i.test(k))
      .sort((a, b) => b[1] - a[1])[0];
    owed = best ? best[1] : null;
    console.log('   delinquency_as_of outstanding  ' + money(owed)
      + (best ? '   (column "' + best[0] + '", ' + dq.rows.length + ' rows)' : ''));
  } catch (e) {
    console.log('   delinquency_as_of              failed: ' + e.message);
  }
  await sleep(800);

  const expected = (billed !== null && owed !== null) ? billed - owed : null;
  console.log('\n   A cash figure should be BELOW ' + money(billed)
    + (expected !== null ? ', in the neighbourhood of ' + money(expected) : '') + '.');
  console.log('   Equal to it means the same accrual number under another name.');
  console.log('   Above it means it is not collections at all.\n');

  // ---- the sweep ------------------------------------------------------------
  console.log('CANDIDATE REPORTS (same property filter)');
  const found = [];

  for (const report of CANDIDATES) {
    const r = await call(report, { ...filter, ...base });
    if (r.status === 404 || /not a valid report/i.test(r.err || '')) {
      console.log('   ' + pad(report, 26) + 'does not exist');
      await sleep(700);
      continue;
    }
    if (r.status >= 400) {
      // A 500 means the NAME is right and the parameters are wrong — worth a
      // human look, unlike a 404.
      console.log('   ' + pad(report, 26) + 'EXISTS but errored ' + r.status + ': ' + (r.err || ''));
      found.push({ report, status: r.status, rows: 0, note: 'exists, parameters wrong' });
      await sleep(700);
      continue;
    }
    const t = totals(r.rows);
    const rent = rentLine(r.rows);
    const cols = Object.keys(r.rows[0] || {});
    console.log('   ' + pad(report, 26) + 'OK  ' + pad(r.rows.length + ' rows', 12)
      + (rent !== null ? 'Rent Income ' + money(rent) : 'no Rent Income line'));
    found.push({ report, rows: r.rows.length, cols, sums: t.sums, rent });
    await sleep(700);
  }

  // ---- what any of it means ---------------------------------------------------
  console.log('\nWHAT CAME BACK, scored against the anchors');
  if (!found.filter(f => f.rows).length) {
    console.log('   Nothing returned rows. There is no cash-basis report under any of');
    console.log('   these names.');
  }
  found.filter(f => f.rows).forEach(f => {
    console.log('\n   ' + f.report + '  (' + f.rows + ' rows)');
    console.log('      columns: ' + (f.cols || []).join(', '));
    // Column totals only. Never a row.
    const money_cols = Object.entries(f.sums)
      .filter(([, v]) => Math.abs(v) > 1)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, 6);
    money_cols.forEach(([k, v]) => {
      let verdict = '';
      if (billed !== null && Math.abs(v - billed) < 1) verdict = '  <-- EQUALS the billed figure (same accrual number)';
      else if (billed !== null && v > 0 && v < billed) {
        const gap = billed - v;
        verdict = '  <-- BELOW billed by ' + money(gap)
          + (owed ? ' (owed is ' + money(owed) + ')' : '');
        if (owed && Math.abs(gap - owed) < owed * 0.5) verdict += '  *** CONSISTENT WITH CASH ***';
      }
      console.log('      ' + pad(k, 30) + pad(money(v), 14) + verdict);
    });
  });

  console.log('\nVERDICT IS YOURS TO WRITE. This prints arithmetic, not a conclusion.');
  console.log('   A column marked CONSISTENT WITH CASH is a candidate, not an answer:');
  console.log('   check it against one property\'s actual receipts in AppFolio before');
  console.log('   anything starts capturing it daily.');
  console.log('\nNothing was written. No row was printed.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
