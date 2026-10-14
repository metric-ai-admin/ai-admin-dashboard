#!/usr/bin/env node
//
// income_statement_comparison: one call, every property, cash basis.
// READ ONLY — report reads, nothing written anywhere.
//
//   node scripts/probe-income-comparison.js
//
// WHAT IS SETTLED (Render, 2026-10-14):
//
//   * the report exists: account_name / properties / total
//   * accounting_basis IS honoured here — Cash 311,166.40, Accrual 379,725.88
//   * `properties` IS the per-property breakdown, as
//         [{"id":1925,"value":"0.00"}, ...]   15 entries
//     keyed by AppFolio property id, so ONE call a day replaces nine
//   * the DATE IS IGNORED, like everywhere else on this endpoint. The figure
//     is month-to-date as of today, whatever date is sent.
//
// WHICH IS WHY THIS DOES NOT EXPECT 42,164.55. That was Katie's workbook at
// 10/12 and today is the 14th, so two more days of receipts are in it. An
// exact match would actually be evidence something is WRONG — a frozen number.
// The three checks are the ones that can be made without a date:
//
//   1. Ascent >= 42,164.55     it has not gone backwards since the 12th
//   2. Ascent <  the accrual   cash received cannot exceed what was billed
//   3. the entries sum to the report's own total, to the cent
//
// Check 3 is the one that matters most and the easiest to skip: it proves the
// breakdown is a decomposition of the total rather than fifteen numbers that
// merely arrived in the same response.
//
// PRIVACY. An income statement holds no resident data. Property names, ids and
// account lines are printed.
require('dotenv').config();

const C = require('../lib/collections-mtd.js');
const PA = require('../lib/property-aliases.js');
const AFP = require('../lib/appfolio-properties.js');

const ID = process.env.APPFOLIO_REPORTS_CLIENT_ID;
const SECRET = process.env.APPFOLIO_REPORTS_CLIENT_SECRET;
const HOST = process.env.APPFOLIO_REPORTS_HOST || 'metricpropertymanagement.appfolio.com';

const REPORT = 'income_statement_comparison';
const LIST_ID = process.env.PROBE_LIST_ID || 'l_32';
const ASCENT_ID = process.env.PROBE_PROPERTY_ID || '1703';

// Katie's workbook: Ascent, cash, as of 10/12.
const WB_CASH_1012 = 42164.55;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = (s, w) => String(s).padEnd(w);
const money = n => (n === null || n === undefined ? '—'
  : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

async function call(body, attempt) {
  const r = await global.fetch('https://' + HOST + '/api/v2/reports/' + REPORT + '.json', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(ID + ':' + SECRET).toString('base64'),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (r.status === 429) {
    const n = (attempt || 0) + 1;
    if (n > 5) throw new Error('rate limited five times');
    const wait = Number(r.headers.get('retry-after')) || 30;
    console.log('   (rate limited, waiting ' + wait + 's)');
    await sleep(wait * 1000);
    return call(body, n);
  }
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch (e) { /* not json */ }
  const rows = Array.isArray(j) ? j : ((j && (j.results || j.data)) || []);
  const err = r.ok ? null : String((j && (j.error || j.message)) || text).slice(0, 140);
  return { status: r.status, rows, err };
}

const rentRow = rows => (rows || []).find(r =>
  /^rent income$/i.test(String(r.account_name || '').trim()));

function request(basis) {
  return {
    property_visibility: 'active',
    paginate_results: false,
    accounting_basis: basis,
    properties: { properties_ids: [LIST_ID] },
  };
}

(async () => {
  if (!ID || !SECRET) {
    console.error('APPFOLIO_REPORTS_CLIENT_ID / _SECRET are not set here. Run on Render Shell.');
    process.exitCode = 1;
    return;
  }
  console.log('READ ONLY. ' + REPORT + ' only. Nothing is written anywhere.\n');

  const cash = await call(request('Cash'));
  if (cash.status >= 400) {
    console.log('HTTP ' + cash.status + ': ' + (cash.err || ''));
    return;
  }
  const rent = rentRow(cash.rows);
  if (!rent) {
    console.log('No "Rent Income" line. Account names seen:');
    [...new Set(cash.rows.map(r => String(r.account_name || '').trim()).filter(Boolean))]
      .slice(0, 30).forEach(n => console.log('   ' + n));
    return;
  }

  const total = C.num(rent.total);
  const b = C.breakdown(rent.properties);
  console.log('Rent Income, cash, month to date as of today');
  console.log('   report total:  ' + money(total));
  console.log('   `properties`:  ' + b.how + '\n');

  const { named, unknown } = C.resolveNames(b, AFP.BY_ID || {});

  // ---- every entry, ours and not ours ---------------------------------------
  console.log('EVERY ENTRY IN THE BREAKDOWN');
  const ours = [];
  Object.entries(named).sort().forEach(([name, v]) => {
    const canon = PA.canonical(name);
    if (canon) ours.push([canon, v]);
    console.log('   ' + pad(name, 34) + pad(money(v), 16)
      + (canon ? 'captured' : 'not one of the eight — not captured'));
  });
  Object.entries(unknown).forEach(([id, v]) => {
    // An id with no name in BY_ID. Printed rather than dropped: a property
    // added in AppFolio and not yet in the id map would otherwise vanish and
    // look like one that collected nothing.
    console.log('   ' + pad('id ' + id + ' (no name in BY_ID)', 34) + pad(money(v), 16)
      + 'UNRESOLVED — add it to the id map or confirm it is not ours');
  });

  // ---- the three checks -----------------------------------------------------
  console.log('\nCHECKS');

  const entries = Object.values(b.map).filter(v => v !== null);
  const sumAll = entries.reduce((a, v) => a + v, 0);
  const sumOurs = ours.reduce((a, [, v]) => a + v, 0);

  const c3 = Math.abs(sumAll - total) < 0.01;
  console.log('   3. the ' + entries.length + ' entries sum to ' + money(sumAll)
    + ' against a report total of ' + money(total));
  console.log('      ' + (c3
    ? 'EXACT — the breakdown IS the total, decomposed. This is the one that matters.'
    : 'OFF BY ' + money(Math.abs(sumAll - total))
      + ' — the breakdown is not a decomposition of the total. Do not build on it.'));
  console.log('      our eight are ' + money(sumOurs) + ', '
    + (total ? Math.round((sumOurs / total) * 100) : '?') + '% of it');

  const ascent = b.map[String(ASCENT_ID)];
  console.log('\n   Ascent (id ' + ASCENT_ID + '): ' + money(ascent));
  if (ascent === undefined || ascent === null) {
    console.log('      NOT IN THE BREAKDOWN. Nothing below can be checked.');
  } else {
    const c1 = ascent >= WB_CASH_1012;
    console.log('   1. >= ' + money(WB_CASH_1012) + ' (the workbook at 10/12): '
      + (c1 ? 'YES — it has not gone backwards' + (ascent > WB_CASH_1012
        ? ', and it is ' + money(ascent - WB_CASH_1012) + ' higher, which is two more days of receipts'
        : ', exactly equal — worth a look, a frozen figure is not a good sign')
        : 'NO — it is BELOW the 12th. Cash received cannot decrease. Stop here.'));

    await sleep(900);
    const acc = await call(request('Accrual'));
    const accRow = acc.status < 400 ? rentRow(acc.rows) : null;
    const accMap = accRow ? C.breakdown(accRow.properties).map : {};
    const accAscent = accMap[String(ASCENT_ID)];
    console.log('   2. <  accrual (' + money(accAscent) + '): '
      + (accAscent === undefined || accAscent === null ? 'accrual figure not found'
        : (ascent < accAscent
          ? 'YES — received is below billed, which is what cash means'
          : 'NO — cash is at or above billed. That is not a cash/accrual pair; stop here.')));
  }

  console.log('\nIF ALL THREE PASS');
  console.log('   The daily sync is ONE call: income_statement_comparison, Cash,');
  console.log('   properties_ids [' + LIST_ID + '], read per property from `properties`.');
  console.log('   Every property is then captured from the same instant instead of');
  console.log('   across ten minutes, and the rate-limit handling stops mattering.');
  console.log('   October still has to be seeded from Katie\'s workbooks: the date is');
  console.log('   ignored, so the API cannot be asked what the 5th or the 12th looked');
  console.log('   like — only what today looks like.');
  console.log('\nNothing was written.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
