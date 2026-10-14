#!/usr/bin/env node
//
// Capture today's month-to-date collections, per property and for the
// portfolio. One row per property per day.
//
//   node scripts/sync-collections-mtd.js
//   node scripts/sync-collections-mtd.js --dry-run
//   node scripts/sync-collections-mtd.js --explain
//
// WHY WE KEEP OUR OWN HISTORY. income_statement filters by property —
// properties: {properties_ids:["1703"]} — and ignores every date parameter in
// every shape tried, so it answers one period of its own choosing and cannot be
// asked about September. Kara's "this month against the same stretch of last
// month" is therefore impossible until a month of these rows exists. The alert
// says that rather than going quiet.
//
// --explain answers the question nobody can ask the report: WHAT PERIOD IS
// THIS? It holds each property's figure against its monthly rent from the rent
// roll and prints the ratio with the reasoning. It is a check, not a verdict:
// "it is probably the current month" is a sentence a person writes after
// seeing the number, not one this script should assert.
//
// ONE CALL PER PROPERTY, spaced. The Reports API throttles on cost and nine
// calls in a burst is how the Asana inventory died.
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const C = require('../lib/collections-mtd.js');
const WEEK = require('../lib/week.js');
const PA = require('../lib/property-aliases.js');

const ID = process.env.APPFOLIO_REPORTS_CLIENT_ID;
const SECRET = process.env.APPFOLIO_REPORTS_CLIENT_SECRET;
const HOST = process.env.APPFOLIO_REPORTS_HOST || 'metricpropertymanagement.appfolio.com';

const db = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = (s, w) => String(s).padEnd(w);
const money = n => (n === null || n === undefined ? '—'
  : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }));

async function statement(propertyId, attempt) {
  const body = { property_visibility: 'active', paginate_results: false };
  // THE SHAPE THAT WORKS. properties_ids / property_ids / property_id are all
  // ignored; this one filters. Probed 2026-10-16.
  if (propertyId) body.properties = { properties_ids: [String(propertyId)] };

  const r = await global.fetch('https://' + HOST + '/api/v2/reports/income_statement.json', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(ID + ':' + SECRET).toString('base64'),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (r.status === 429) {
    const n = (attempt || 0) + 1;
    if (n > 6) throw new Error('rate limited six times on property ' + propertyId);
    const wait = Number(r.headers.get('retry-after')) || 30;
    log('      (rate limited, waiting ' + wait + 's)');
    await sleep(wait * 1000);
    return statement(propertyId, n);
  }
  if (!r.ok) throw new Error('AppFolio ' + r.status + ' for property ' + propertyId);
  const j = await r.json().catch(() => null);
  return Array.isArray(j) ? j : ((j && (j.results || j.data)) || []);
}

// Exported so the 04:30 cron in server.js runs THE SAME CODE this is tested
// with. A cron that re-implements the script is a second thing to keep right.
async function syncCollectionsMtd(opts) {
  const o = opts || {};
  const DRY = o.dryRun || false;
  const EXPLAIN = o.explain || false;
  const log = o.log || console.log;
  if (!ID || !SECRET) {
    throw new Error('APPFOLIO_REPORTS_CLIENT_ID / _SECRET are not set. Run on Render.');
  }
  const today = WEEK.todayYMD();
  const AFP = require('../lib/appfolio-properties.js');
  // BY_ID is the id -> name map lib/appfolio-properties.js derives from six
  // synced tables. Using it means a property added there is captured here
  // without anybody remembering this file.
  // THE EIGHT WE MANAGE, not all sixteen ids AppFolio knows about. BY_ID also
  // holds "Metric Property Management of Texas LLC", "Live With Metric",
  // Brazos Lofts, The Sidney and a street address — capturing those would be
  // sixteen calls a day and a history of entities nobody is asking about.
  //
  // THE SKIPPED ONES ARE PRINTED. Filtering quietly is how a property stops
  // being measured and nobody notices for a quarter.
  const all = Object.entries(AFP.BY_ID || {});
  const ids = all.filter(([, name]) => PA.canonical(name));
  const skipped = all.filter(([, name]) => !PA.canonical(name)).map(([, n]) => n);
  log('capturing ' + today + ' (Central) — ' + ids.length + ' properties + portfolio');
  if (skipped.length) log('not captured: ' + skipped.join(', '));
  log('');

  const rows = [];

  // The portfolio first, so a failure part-way still leaves the total.
  const portfolio = C.readStatement(await statement(null));
  rows.push({
    captured_on: today, property: C.PORTFOLIO, property_id: null,
    rent_income: portfolio.rentIncome, total_income: portfolio.totalIncome,
    accounts: portfolio.accounts, source: 'income_statement',
    period_note: 'the report accepts no date parameter; the period is whatever it chooses',
  });
  log(pad('PORTFOLIO', 26) + pad(money(portfolio.rentIncome), 14)
    + Object.keys(portfolio.accounts).length + ' income lines');
  await sleep(900);

  for (const [id, name] of ids) {
    try {
      const s = C.readStatement(await statement(id));
      rows.push({
        captured_on: today, property: name, property_id: String(id),
        rent_income: s.rentIncome, total_income: s.totalIncome,
        accounts: s.accounts, source: 'income_statement',
        period_note: 'the report accepts no date parameter; the period is whatever it chooses',
      });
      log(pad(name, 26) + pad(money(s.rentIncome), 14)
        + Object.keys(s.accounts).length + ' income lines');
    } catch (e) {
      // A property that fails is REPORTED and left out; a zero would enter the
      // history as a collapse in collections.
      log(pad(name, 26) + 'FAILED: ' + e.message);
    }
    await sleep(900);
  }

  // ---- what period is this -------------------------------------------------
  if (EXPLAIN) {
    log('\nWHAT PERIOD DOES THE REPORT COVER?');
    log('   Held against each property\'s monthly rent from the rent roll.');
    const af = require('../appfolio-reports.js');
    const rr = (((await af.readReportData('rent_roll')) || {}).rows) || [];
    const monthly = {};
    rr.forEach(r => {
      const p = PA.canonical(r.property_name || r.property);
      const v = C.num(r.rent);
      if (p && v) monthly[p] = (monthly[p] || 0) + v;
    });
    rows.filter(r => r.property !== C.PORTFOLIO).forEach(r => {
      const chk = C.periodCheck(r.rent_income, monthly[r.property], today);
      log('   ' + pad(r.property, 24)
        + pad(money(r.rent_income), 12) + 'of ' + pad(money(monthly[r.property]), 12)
        + (chk ? '= ' + chk.ratio + '   ' + chk.note : 'no rent roll figure'));
    });
    log('\n   The month is ' + Math.round(100 * (Number(today.slice(8)) / 30))
      + '% elapsed. A figure near a full month means the current month-to-date;');
    log('   far below one means the report is describing something else.');
    log('   THIS IS A CHECK, NOT A VERDICT — read it and decide.');
  }

  const accountNames = new Set();
  rows.forEach(r => Object.keys(r.accounts).forEach(k => accountNames.add(k)));
  log('\nINCOME LINES SEEN (these are what "cash receipts" has to be chosen from):');
  [...accountNames].sort().forEach(n => log('   ' + n));
  log('\n   All of them are stored whole, so the definition can change without');
  log('   re-syncing. rent_income is denormalised because it is what the');
  log('   comparison currently uses.');

  if (DRY) { log('\nDRY RUN — nothing written.'); return { captured: rows.length, written: 0, day: today }; }

  const { error } = await db.from('collections_mtd')
    .upsert(rows, { onConflict: 'captured_on,property' });
  if (error) throw new Error(error.message);
  log('\nstored: ' + rows.length + ' rows for ' + today);
  return { captured: rows.length, written: rows.length, day: today };
}

module.exports = { syncCollectionsMtd };

if (require.main === module) {
  syncCollectionsMtd({
    dryRun: process.argv.includes('--dry-run'),
    explain: process.argv.includes('--explain'),
  }).catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
}
