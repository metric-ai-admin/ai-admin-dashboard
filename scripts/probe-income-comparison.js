#!/usr/bin/env node
//
// income_statement_comparison: one call, every property, cash basis?
// READ ONLY — report reads, nothing written anywhere.
//
//   node scripts/probe-income-comparison.js
//
// WHERE THIS STANDS. The report exists and returns three columns:
// account_name, properties, total. With accounting_basis the numbers MOVE —
// Cash 311,166.40 against Accrual 379,725.88 — so the basis is honoured here,
// unlike on income_statement.
//
// THE `properties` FIELD IS THE POINT. If it carries one figure per property,
// the daily capture is ONE call a day instead of nine, and the rate-limit
// dance disappears with it. This prints its shape and holds Ascent against
// Katie's workbook: Rent Income cash at 10/12 = 42,164.55.
//
// TWO THINGS ARTURO'S RUN LEFT OPEN, and both change what gets built:
//
//   1. l_32 DID NOT FILTER. 311,166.40 is exactly the portfolio total already
//      on file, so that id selected everything rather than Ascent — `l_` looks
//      like a LIST id, not a property id. That is good news if `properties`
//      breaks the total down per property: we want everything in one call.
//      It is only a problem if we still need to filter.
//
//   2. WITH 1703, CASH CAME BACK ABOVE ACCRUAL (56,335.98 > 54,256.88). Cash
//      received cannot exceed what was billed on the same ledger, so that pair
//      is not a cash/accrual pair at all — something about 1703 is being
//      ignored or reinterpreted. An id that is ignored and an id that works
//      produce equally confident numbers, so this probes the id FORMATS
//      (p_1703, l_1703, bare) and reports what each returns.
//
// AND THE QUESTION NOBODY HAS ASKED YET. Does posted_on_relative_to actually
// move the number? If it does, October and September can be read STRAIGHT FROM
// THE API and no seeding from workbooks is needed at all — the comparison
// works from day one instead of from 5 November. That is worth three requests
// to find out, so this asks for the same figure at three different dates and
// prints them side by side.
//
// PRIVACY. An income statement holds no resident data. Property names and
// account lines are printed; no attempt is made to dump rows wholesale.
require('dotenv').config();

const C = require('../lib/collections-mtd.js');

const ID = process.env.APPFOLIO_REPORTS_CLIENT_ID;
const SECRET = process.env.APPFOLIO_REPORTS_CLIENT_SECRET;
const HOST = process.env.APPFOLIO_REPORTS_HOST || 'metricpropertymanagement.appfolio.com';

const REPORT = 'income_statement_comparison';
const LIST_ID = process.env.PROBE_LIST_ID || 'l_32';
const AS_OF = process.env.PROBE_AS_OF || '2026-10-12';
const PROP_NAME = process.env.PROBE_PROPERTY_NAME || 'Ascent';

// Katie's workbook, same report, same date, same property.
const WB_CASH = 42164.55;

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
    if (n > 5) return { status: 429, rows: [], err: 'rate limited five times' };
    const wait = Number(r.headers.get('retry-after')) || 30;
    console.log('      (rate limited, waiting ' + wait + 's)');
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

// `breakdown` lives in lib/collections-mtd.js, not here: the probe and the
// sync that may follow it have to read this field the SAME way, and two copies
// of that logic is how they stop agreeing.
const breakdown = C.breakdown;

const findProp = (map, name) => Object.entries(map)
  .find(([k]) => new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(k));

(async () => {
  if (!ID || !SECRET) {
    console.error('APPFOLIO_REPORTS_CLIENT_ID / _SECRET are not set here. Run on Render Shell.');
    process.exitCode = 1;
    return;
  }
  console.log('READ ONLY. ' + REPORT + ' only. Nothing is written anywhere.\n');

  const base = {
    property_visibility: 'active',
    paginate_results: false,
    accounting_basis: 'Cash',
  };

  // ---- 1. the breakdown ------------------------------------------------------
  console.log('ONE CALL: Cash, posted_on_relative_to ' + AS_OF + ', properties_ids [' + LIST_ID + ']');
  const main = await call({
    ...base,
    posted_on_relative_to: AS_OF,
    properties: { properties_ids: [LIST_ID] },
  });

  if (main.status >= 400) {
    console.log('   HTTP ' + main.status + ': ' + (main.err || ''));
    console.log('\n   Nothing else can be scored without this call. Stopping.');
    return;
  }

  console.log('   ' + main.rows.length + ' rows, columns: ' + Object.keys(main.rows[0] || {}).join(', '));
  const rent = rentRow(main.rows);
  if (!rent) {
    console.log('   No "Rent Income" line. Account names seen:');
    [...new Set(main.rows.map(r => String(r.account_name || '').trim()).filter(Boolean))]
      .slice(0, 30).forEach(n => console.log('      ' + n));
    return;
  }
  console.log('   Rent Income total: ' + money(num(rent.total)));

  const b = breakdown(rent.properties);
  console.log('   `properties` is ' + b.how);

  const names = Object.keys(b.map);
  if (!names.length) {
    console.log('\n   NO PER-PROPERTY BREAKDOWN. One call cannot replace nine, and the');
    console.log('   sync keeps a call per property — but on THIS report, with the basis');
    console.log('   honoured. Check the raw shape printed above against the API docs.');
  } else {
    console.log('\n   PER PROPERTY (Rent Income, cash, as of ' + AS_OF + ')');
    names.sort().forEach(n => console.log('      ' + pad(n, 34) + money(b.map[n])));

    const hit = findProp(b.map, PROP_NAME);
    console.log('\n   ' + PROP_NAME + ': ' + (hit ? money(hit[1]) + '   (column "' + hit[0] + '")' : 'NOT FOUND'));
    console.log('   workbook:  ' + money(WB_CASH));
    if (hit && hit[1] !== null) {
      const diff = Math.abs(hit[1] - WB_CASH);
      console.log('   ' + (diff < 0.01
        ? '*** EXACT MATCH — this is Katie\'s saved report, read through the API ***'
        : (diff < WB_CASH * 0.02
          ? 'within 2% — close, but not the same number. Find out why before capturing.'
          : 'DIFFERENT by ' + money(diff) + '. Not the same figure; do not wire this up yet.')));
    }
  }

  // ---- 2. does the date move the number --------------------------------------
  //
  // If it does, October and September can be read directly and the workbook
  // seeding is unnecessary — the comparison works from 1 November rather than
  // from the 5th.
  console.log('\nDOES posted_on_relative_to ACTUALLY MOVE THE NUMBER?');
  const dates = [AS_OF, '2026-10-05', '2026-09-12', null];
  const seen = [];
  for (const d of dates) {
    await sleep(800);
    const body = { ...base, properties: { properties_ids: [LIST_ID] } };
    if (d) body.posted_on_relative_to = d;
    const r = await call(body);
    const row = r.status < 400 ? rentRow(r.rows) : null;
    const total = row ? num(row.total) : null;
    const one = row ? (findProp(breakdown(row.properties).map, PROP_NAME) || [null, null])[1] : null;
    seen.push({ d: d || '(no date)', total, one });
    console.log('   ' + pad(d || '(no date)', 16) + 'total ' + pad(money(total), 18)
      + PROP_NAME + ' ' + money(one));
  }
  const totals = seen.map(s => s.total).filter(v => v !== null);
  const allSame = totals.length > 1 && totals.every(v => Math.abs(v - totals[0]) < 0.01);
  console.log('\n   ' + (allSame
    ? 'IDENTICAL at every date — the date is ignored, exactly like on'
      + '\n   income_statement. October has to come from Katie\'s workbooks after all'
      + '\n   (scripts/seed-collections-mtd.js), and the history starts there.'
    : 'THE DATE MOVES THE NUMBER. October and September can be read straight'
      + '\n   from the API — the seeding from workbooks is not needed, and the'
      + '\n   comparison can start on 1 November instead of the 5th.'));

  // ---- 3. the id formats ------------------------------------------------------
  //
  // 1703 gave cash ABOVE accrual, which is not a thing. Either it is ignored,
  // or it means something else on this report. The prefixes are tried because
  // the saved report's URL uses one.
  console.log('\nPROPERTY ID FORMATS (is there one that selects a SINGLE property?)');
  const idShapes = [
    ['p_1703', { properties: { properties_ids: ['p_1703'] } }],
    ['l_1703', { properties: { properties_ids: ['l_1703'] } }],
    ['1703', { properties: { properties_ids: ['1703'] } }],
    [LIST_ID + ' (the list)', { properties: { properties_ids: [LIST_ID] } }],
  ];
  for (const [label, body] of idShapes) {
    await sleep(800);
    const r = await call({ ...base, posted_on_relative_to: AS_OF, ...body });
    if (r.status >= 400) {
      console.log('   ' + pad(label, 24) + 'HTTP ' + r.status + ': ' + (r.err || ''));
      continue;
    }
    const row = rentRow(r.rows);
    const bb = row ? breakdown(row.properties) : { map: {}, how: 'no Rent Income row' };
    const keys = Object.keys(bb.map);
    console.log('   ' + pad(label, 24) + 'total ' + pad(money(row ? num(row.total) : null), 18)
      + keys.length + ' propert' + (keys.length === 1 ? 'y' : 'ies')
      + (keys.length === 1 ? ': ' + keys[0] : ''));
  }

  console.log('\nWHAT TO DO WITH THIS');
  console.log('   A per-property breakdown in one call is the whole prize: the sync');
  console.log('   becomes one request a day, the 900ms spacing and the 429 handling');
  console.log('   stop mattering, and every property is captured from the same instant');
  console.log('   rather than across ten minutes.');
  console.log('   Nothing gets wired up until Ascent matches the workbook exactly.');
  console.log('\nNothing was written.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
