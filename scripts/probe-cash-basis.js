#!/usr/bin/env node
//
// Is there a CASH-BASIS collections figure, per property, in the Reports API?
// READ ONLY — report reads, nothing written anywhere.
//
//   node scripts/probe-cash-basis.js
//
// WHY THIS EXISTS. The dry run on 2026-10-14 showed income_statement reports
// BILLED income, not money received: Ascent came back at 56,336 against 47,301
// of monthly rent while carrying 16,118 of delinquency. Kara's alert is about
// cash RECEIVED.
//
// WHAT KATIE'S WORKBOOKS GAVE US. Her saved report is "Income Statement -
// Property Comparison", Accounting Basis: Cash, Period Basis: Calendar, one
// column per property. The tab URLs carry the filters the UI actually sends:
//
//   filters[properties_ids][0]=l_32
//   filters[posted_on_relative_to]=2026-10-12
//
// Two things in there that every previous probe missed. `posted_on_relative_to`
// is a date parameter NAME WE NEVER TRIED — the earlier sweep guessed
// period_from, posted_on_from, accounting_date_from and a filters object, and
// concluded "no date parameter works", which was only ever a statement about
// the names in that list. And the property id is `l_32`, not the bare `1703`
// that works on income_statement: a different id namespace, so both are tried.
//
// THE ANCHOR IS ARITHMETIC. Ascent at 10/12, from the workbook:
//
//   Cash Rent Income     42,164.55
//   Accrual Rent Income  48,175.63
//
// So a request that is genuinely honouring the basis must return LESS on Cash
// than on Accrual for the same date. That comparison is the whole test. A
// parameter that is accepted and ignored returns a full-looking response with
// identical numbers, which is how `from_date` on the applications report cost
// a morning and how income_statement wasted three probes.
//
// PRIVACY. Nothing here prints a row. Column headers on this report are
// PROPERTY names, which are fine; account lines are fine. No resident data
// exists in an income statement, but the row printer is restricted anyway.
require('dotenv').config();

const ID = process.env.APPFOLIO_REPORTS_CLIENT_ID;
const SECRET = process.env.APPFOLIO_REPORTS_CLIENT_SECRET;
const HOST = process.env.APPFOLIO_REPORTS_HOST || 'metricpropertymanagement.appfolio.com';

// Ascent, in both namespaces. 1703 is the id that filters income_statement;
// l_32 is what the saved report's URL carries.
const PROP = process.env.PROBE_PROPERTY_ID || '1703';
const PROP_ALT = process.env.PROBE_PROPERTY_ALT || 'l_32';
const PROP_NAME = process.env.PROBE_PROPERTY_NAME || 'Ascent';
const AS_OF = process.env.PROBE_AS_OF || '2026-10-12';

// From Katie's workbook, same property, same date. The numbers this is trying
// to reproduce.
const WB_CASH = 42164.55;
const WB_ACCRUAL = 48175.63;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = (s, w) => String(s).padEnd(w);
const money = n => (n === null || n === undefined ? '—'
  : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

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
    if (n > 5) return { status: 429, rows: [], err: 'rate limited five times' };
    const wait = Number(r.headers.get('retry-after')) || 30;
    console.log('      (rate limited, waiting ' + wait + 's)');
    await sleep(wait * 1000);
    return call(report, body, n);
  }
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch (e) { /* not json */ }
  const rows = Array.isArray(j) ? j : ((j && (j.results || j.data)) || []);
  const err = r.ok ? null : String((j && (j.error || j.message)) || text).slice(0, 140);
  return { status: r.status, rows, err };
}

// ---- finding Ascent's rent in whatever shape comes back ---------------------
//
// Two layouts are possible and the extractor handles both WITHOUT being told
// which: a plain income statement (one value column) and a property comparison
// (one column PER PROPERTY, so the figure sits under a header containing the
// property name). Being told which layout to expect is how a reader ends up
// confirming the layout it assumed.
function rentFor(rows, propertyName) {
  const row = (rows || []).find(r =>
    Object.values(r || {}).some(v => /^rent income$/i.test(String(v || '').trim())));
  if (!row) return { value: null, how: 'no Rent Income line' };

  // Comparison layout: a column whose NAME contains the property.
  const byCol = Object.entries(row).find(([k]) =>
    new RegExp(propertyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(k));
  if (byCol && num(byCol[1]) !== null) {
    return { value: num(byCol[1]), how: 'column "' + byCol[0] + '"' };
  }

  // Plain layout: the first non-zero number on the line.
  const first = Object.entries(row)
    .map(([k, v]) => [k, num(v)])
    .find(([, n]) => n !== null && n !== 0);
  return first
    ? { value: first[1], how: 'column "' + first[0] + '"' }
    : { value: null, how: 'Rent Income line has no number' };
}

const REPORTS = [
  'income_statement_comparison',
  'income_statement_property_comparison',
  'property_comparison',
  'income_statement_by_property',
  'income_statement',            // the control: we know it answers accrual
];

// Basis and date shapes. Capitalisation included on purpose — the saved report
// shows "Cash" with a capital, and the earlier probe only ever sent 'cash'.
const BASIS = [
  ['Cash', { accounting_basis: 'Cash' }],
  ['cash', { accounting_basis: 'cash' }],
  ['Cash (nested)', { filters: { accounting_basis: 'Cash' } }],
  ['Accrual', { accounting_basis: 'Accrual' }],
];

const DATES = [
  ['posted_on_relative_to', { posted_on_relative_to: AS_OF }],
  ['filters.posted_on_relative_to', { filters: { posted_on_relative_to: AS_OF } }],
  ['posted_on_to', { posted_on_to: AS_OF }],
  ['none', {}],
];

const PROPS = [
  ['properties_ids [' + PROP + ']', { properties: { properties_ids: [PROP] } }],
  ['properties_ids [' + PROP_ALT + ']', { properties: { properties_ids: [PROP_ALT] } }],
  ['filters.properties_ids [' + PROP_ALT + ']', { filters: { properties_ids: [PROP_ALT] } }],
];

// Merge that does not let a later `filters` object clobber an earlier one —
// the whole point of several shapes is combining them.
function merge(...parts) {
  const out = {};
  parts.forEach(p => {
    Object.entries(p || {}).forEach(([k, v]) => {
      if (k === 'filters' && out.filters) out.filters = { ...out.filters, ...v };
      else out[k] = v;
    });
  });
  return out;
}

(async () => {
  if (!ID || !SECRET) {
    console.error('APPFOLIO_REPORTS_CLIENT_ID / _SECRET are not set here. Run on Render Shell.');
    process.exitCode = 1;
    return;
  }
  console.log('READ ONLY. Report reads only. Nothing is written anywhere.\n');
  console.log('TARGET, from Katie\'s workbook — ' + PROP_NAME + ' at ' + AS_OF + ':');
  console.log('   Cash Rent Income     ' + money(WB_CASH));
  console.log('   Accrual Rent Income  ' + money(WB_ACCRUAL));
  console.log('   A request honouring the basis returns LESS on Cash than on Accrual.\n');

  const base = { property_visibility: 'active', paginate_results: false };

  // ---- 1. which of these report names exist --------------------------------
  console.log('DO THESE REPORTS EXIST?');
  const live = [];
  for (const report of REPORTS) {
    const r = await call(report, base);
    if (r.status === 404 || /not a valid report/i.test(r.err || '')) {
      console.log('   ' + pad(report, 38) + 'does not exist');
    } else if (r.status >= 400) {
      // The name is RIGHT and the parameters are wrong — that is a lead, not a
      // dead end. income_statement's property filter was found this way.
      console.log('   ' + pad(report, 38) + 'EXISTS, errored ' + r.status + ': ' + (r.err || ''));
      live.push(report);
    } else {
      console.log('   ' + pad(report, 38) + 'OK, ' + r.rows.length + ' rows'
        + (r.rows.length ? '   columns: ' + Object.keys(r.rows[0]).slice(0, 8).join(', ') : ''));
      live.push(report);
    }
    await sleep(700);
  }

  if (!live.length) {
    console.log('\n   None of these names exist. The saved report is not reachable under');
    console.log('   any of them, and the next question is for AppFolio support: what is');
    console.log('   the API id of "Income Statement - Property Comparison"?');
    console.log('\nNothing was written.');
    return;
  }

  // ---- 2. does the basis actually change the number ------------------------
  //
  // Run on each surviving report: the SAME date and property, Cash against
  // Accrual. If the two come back equal, the parameter is decoration.
  console.log('\nDOES ACCOUNTING_BASIS CHANGE THE NUMBER?');
  const hits = [];

  for (const report of live) {
    console.log('\n   ' + report);
    // The control is already understood: it answers accrual and ignores every
    // date name tried so far. Only the NEW parameter is worth spending calls
    // on there — the rest would be 48 requests to re-learn a known answer.
    const dates = report === 'income_statement'
      ? DATES.filter(([l]) => /posted_on_relative_to/.test(l))
      : DATES;
    let done = false;
    for (const [dLabel, dBody] of dates) {
      if (done) break;
      for (const [pLabel, pBody] of PROPS) {
        const results = {};
        for (const [bLabel, bBody] of BASIS) {
          const r = await call(report, merge(base, pBody, dBody, bBody));
          results[bLabel] = r.status >= 400
            ? { value: null, how: 'HTTP ' + r.status }
            : rentFor(r.rows, PROP_NAME);
          await sleep(700);
        }
        const cash = results['Cash'].value;
        const accrual = results['Accrual'].value;
        const line = pad(dLabel + ' + ' + pLabel, 52)
          + 'Cash ' + pad(money(cash), 16) + 'Accrual ' + pad(money(accrual), 16);

        let verdict = '';
        if (cash === null && accrual === null) verdict = 'no figure';
        else if (cash !== null && accrual !== null && Math.abs(cash - accrual) < 0.01) {
          verdict = 'IDENTICAL — basis ignored';
        } else if (cash !== null && accrual !== null && cash < accrual) {
          verdict = 'CASH < ACCRUAL — the basis is being honoured';
          if (Math.abs(cash - WB_CASH) < 0.01) verdict += '  *** MATCHES THE WORKBOOK EXACTLY ***';
          else if (Math.abs(cash - WB_CASH) < WB_CASH * 0.1) verdict += '  *** within 10% of the workbook ***';
          hits.push({ report, date: dLabel, prop: pLabel, cash, accrual,
            exact: Math.abs(cash - WB_CASH) < 0.01 });
        } else if (cash !== null && accrual !== null) {
          verdict = 'cash ABOVE accrual — not what the basis means';
        } else {
          verdict = 'only one side answered';
        }
        console.log('      ' + line + verdict);
        // An exact reproduction of the workbook answers the question. Carrying
        // on would be another sixty calls to confirm it twice.
        if (hits.length && hits[hits.length - 1].exact) { done = true; break; }
      }
    }
  }

  // ---- 3. the answer --------------------------------------------------------
  console.log('\nWHAT THIS SETTLES');
  if (!hits.length) {
    console.log('   No combination made Cash differ from Accrual. The basis cannot be');
    console.log('   chosen through the API with any of these names, and the collections');
    console.log('   alert has to be relabelled "billed income" or left unbuilt — the');
    console.log('   decision Arturo is taking with Kara.');
  } else {
    const exact = hits.filter(h => h.exact);
    (exact.length ? exact : hits).slice(0, 5).forEach(h => {
      console.log('   ' + h.report + '  with  ' + h.date + '  +  ' + h.prop);
      console.log('      Cash ' + money(h.cash) + '   Accrual ' + money(h.accrual)
        + (h.exact ? '   — reproduces the workbook exactly' : ''));
    });
    console.log('\n   ' + (exact.length
      ? 'An exact match means this IS Katie\'s saved report. Wire collections_mtd'
        + '\n   to it and the alert can honestly say "collections".'
      : 'Close but not exact. Before anything captures daily, check why it differs'
        + '\n   — a near miss is usually a different date anchor or a second account'
        + '\n   line, and both change what the history means.'));
  }
  console.log('\nNothing was written. No row was printed.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
