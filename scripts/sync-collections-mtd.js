#!/usr/bin/env node
//
// Capture today's month-to-date collections, per property and for the
// portfolio. One row per property per day.
//
//   node scripts/sync-collections-mtd.js
//   node scripts/sync-collections-mtd.js --dry-run
//   node scripts/sync-collections-mtd.js --explain
//
// ONE CALL A DAY. income_statement_comparison returns account_name /
// properties / total, and `properties` is the per-property breakdown keyed by
// AppFolio id — [{"id":1703,"value":"42164.55"}, ...]. So every property is
// captured from the SAME INSTANT, rather than across the ten minutes nine
// spaced calls used to take. The rate-limit dance went with it.
//
// CASH BASIS, and that is the whole point. accounting_basis is honoured on
// this report (Cash 311,166.40 against Accrual 379,725.88) and ignored on
// income_statement. Kara's alert is about money RECEIVED; billed income would
// answer a different question with an equally confident number.
//
// THE PERIOD IS NOT SETTLED, AND THIS WILL NOT RUN UNTIL IT IS. Arturo opened
// the saved report in AppFolio on 2026-10-15: October reads 278,803.67 total,
// Ascent 43,055.01. The API's default period returns 311,166.40 and 56,335.98
// — a DIFFERENT PERIOD, probably September, and nothing in the response says
// which. Capturing that and dating it today would fill the history with the
// wrong month under the right date, and every comparison built on it would be
// nonsense that looks like arithmetic.
//
// FOUND, 2026-10-15: posted_on_from / posted_on_to = "2026-10" reproduces the
// saved report exactly — 278,803.67 total, Ascent 43,055.01. Both ends of the
// range are the MONTH, not a day.
//
// Derived from the capture date rather than written down, so the sync follows
// the calendar instead of needing an edit every 1st. A hardcoded month would
// keep returning October through all of November, with each row dated
// correctly — the failure this whole file is built to avoid.
const PERIOD_PARAMS = ymd => ({
  posted_on_from: String(ymd).slice(0, 7),
  posted_on_to: String(ymd).slice(0, 7),
});
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const C = require('../lib/collections-mtd.js');
const WEEK = require('../lib/week.js');
const PA = require('../lib/property-aliases.js');
const AFP = require('../lib/appfolio-properties.js');

const ID = process.env.APPFOLIO_REPORTS_CLIENT_ID;
const SECRET = process.env.APPFOLIO_REPORTS_CLIENT_SECRET;
const HOST = process.env.APPFOLIO_REPORTS_HOST || 'metricpropertymanagement.appfolio.com';
const LIST_ID = process.env.COLLECTIONS_MTD_LIST_ID || 'l_32';

const db = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = (s, w) => String(s).padEnd(w);
const money = n => (n === null || n === undefined ? '—'
  : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }));

// The period is now EXPLICIT and recorded on every row. The stored note used
// to say the report could only answer about today, which was true of what we
// knew and false of the report.
const periodNote = period => 'cash basis, income_statement_comparison, '
  + 'posted_on_from/to = ' + period.posted_on_from + '; month-to-date as of the '
  + 'capture date. Verified against the AppFolio saved report on 2026-10-15: '
  + 'October total 278,803.67, Ascent 43,055.01.';

async function statement(period, attempt) {
  const r = await global.fetch('https://' + HOST + '/api/v2/reports/income_statement_comparison.json', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(ID + ':' + SECRET).toString('base64'),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      property_visibility: 'active',
      paginate_results: false,
      accounting_basis: 'Cash',
      properties: { properties_ids: [LIST_ID] },
      ...(period || {}),
    }),
  });
  if (r.status === 429) {
    const n = (attempt || 0) + 1;
    if (n > 6) throw new Error('rate limited six times');
    const wait = Number(r.headers.get('retry-after')) || 30;
    await sleep(wait * 1000);
    return statement(period, n);
  }
  if (!r.ok) throw new Error('AppFolio ' + r.status + ' on income_statement_comparison');
  const j = await r.json().catch(() => null);
  return Array.isArray(j) ? j : ((j && (j.results || j.data)) || []);
}

const RENT_LINE = /^rent income$/i;
const TOTAL_LINE = /^total (income|revenue|operating income)$/i;
const INCOME_SECTION = /income|revenue|receipt/i;

// Exported so the cron in server.js runs THE SAME CODE this is tested with. A
// cron that re-implements the script is a second thing to keep right.
async function syncCollectionsMtd(opts) {
  const o = opts || {};
  const DRY = o.dryRun || false;
  const EXPLAIN = o.explain || false;
  const log = o.log || console.log;
  if (!ID || !SECRET) {
    throw new Error('APPFOLIO_REPORTS_CLIENT_ID / _SECRET are not set. Run on Render.');
  }
  // REFUSE RATHER THAN CAPTURE THE WRONG MONTH. Without a period parameter
  // the report answers for a period of its own choosing — 311,166.40 where
  // AppFolio shows October as 278,803.67 — and the row would be stored under
  // today's date. A history of the wrong month under the right dates is worse
  // than no history: every figure in it is real, so nothing ever looks wrong.
  const today = WEEK.todayYMD();
  const period = o.period || PERIOD_PARAMS(today);
  // The guard stays even though the parameter is now known: if PERIOD_PARAMS
  // is ever emptied or returns nothing, the report falls back to a period of
  // its own choosing and the row is still stored under today's date. Every
  // figure in it would be real, so nothing would ever look wrong.
  if (!period || !Object.keys(period).length) {
    throw new Error('no period parameter, so this would capture whatever period '
      + 'the report defaults to and date it today. See PERIOD_PARAMS.');
  }

  const rows = await statement(period);
  log('captured ' + today + ' (Central) for period ' + period.posted_on_from
    + ' — one call, ' + rows.length + ' account lines');

  // ---- fold the report into per-property account maps ----------------------
  //
  // Each row is one account line with a breakdown across properties. We want
  // the transpose: one account map per property.
  const byProperty = new Map();   // name -> { accounts, id }
  const portfolio = {};
  const unresolved = new Map();   // id -> the account lines it appeared on
  const notOurs = new Set();      // resolved, but not one of the eight
  let shapeProblem = null;

  rows.forEach(row => {
    const account = C.clean(row.account_name);
    if (!account) return;
    const keep = INCOME_SECTION.test(account) || RENT_LINE.test(account);
    if (!keep) return;

    const total = C.num(row.total);
    if (total !== null) portfolio[account] = total;

    const b = C.breakdown(row.properties);
    // A shape this code does not recognise must be LOUD. An empty breakdown
    // and an absent one look identical from the outside, and that is how the
    // tenant directory stored 411 residents and zero phone numbers.
    if (!Object.keys(b.map).length && !shapeProblem) shapeProblem = b.how;

    const { named, unknown } = C.resolveNames(b, AFP.BY_ID || {});
    Object.entries(named).forEach(([name, value]) => {
      const canon = PA.canonical(name);
      if (!canon) {
        // Resolves to a name, but not one of the eight we manage — the LLC
        // entities, Brazos Lofts, 17th Street. Deliberately not stored, and
        // deliberately NAMED: a property quietly missing from the capture and
        // a property we chose not to capture look identical in the table a
        // month later.
        notOurs.add(name);
        return;
      }
      if (!byProperty.has(canon)) byProperty.set(canon, { accounts: {}, id: null });
      byProperty.get(canon).accounts[account] = value;
    });
    Object.keys(unknown).forEach(id => {
      if (!unresolved.has(id)) unresolved.set(id, []);
      unresolved.get(id).push(account);
    });
  });

  if (shapeProblem) {
    throw new Error('the `properties` field was not readable: ' + shapeProblem
      + ' — nothing captured, because a capture of zeroes would enter the history '
      + 'as a month where nobody paid');
  }

  // The id for each property we did resolve, for the stored row.
  const idByName = {};
  Object.entries(AFP.BY_ID || {}).forEach(([id, name]) => {
    const canon = PA.canonical(name);
    if (canon && !idByName[canon]) idByName[canon] = String(id);
  });

  // ---- the rows ------------------------------------------------------------
  const payload = [{
    captured_on: today,
    property: C.PORTFOLIO,
    property_id: null,
    rent_income: portfolio[Object.keys(portfolio).find(k => RENT_LINE.test(k)) || ''] ?? null,
    total_income: portfolio[Object.keys(portfolio).find(k => TOTAL_LINE.test(k)) || ''] ?? null,
    accounts: portfolio,
    source: 'income_statement_comparison_cash',
    period_note: periodNote(period),
  }];

  [...byProperty.entries()].sort().forEach(([name, { accounts }]) => {
    const rentKey = Object.keys(accounts).find(k => RENT_LINE.test(k));
    const totalKey = Object.keys(accounts).find(k => TOTAL_LINE.test(k));
    payload.push({
      captured_on: today,
      property: name,
      property_id: idByName[name] || null,
      rent_income: rentKey ? accounts[rentKey] : null,
      total_income: totalKey ? accounts[totalKey] : null,
      accounts,
      source: 'income_statement_comparison_cash',
      period_note: periodNote(period),
    });
  });

  payload.forEach(r => log(pad(r.property === C.PORTFOLIO ? 'PORTFOLIO' : r.property, 26)
    + pad(money(r.rent_income), 14) + Object.keys(r.accounts).length + ' income lines'));

  // ---- what we did not capture, out loud -----------------------------------
  if (notOurs.size) {
    log('not captured (not one of the eight we manage): ' + [...notOurs].sort().join(', '));
  }
  if (unresolved.size) {
    log('not captured: ' + unresolved.size + ' AppFolio id(s) with no name in the id map — '
      + [...unresolved.keys()].join(', '));
    log('   add them to lib/appfolio-properties.js or confirm they are not ours. '
      + 'An id that stops resolving looks exactly like a property that collected nothing.');
  }

  // ---- does the arithmetic hold -------------------------------------------
  //
  // The per-property figures have to add up to the report's own total. If they
  // do not, the breakdown is not a decomposition and the capture is fifteen
  // numbers that merely arrived together.
  const rentKey = Object.keys(portfolio).find(k => RENT_LINE.test(k));
  if (rentKey) {
    const ours = payload.filter(r => r.property !== C.PORTFOLIO)
      .reduce((a, r) => a + (r.rent_income || 0), 0);
    log('our ' + (payload.length - 1) + ' properties: ' + money(ours)
      + ' of a portfolio ' + money(portfolio[rentKey]));
  }

  if (EXPLAIN) {
    log('');
    log('WHAT PERIOD DOES THE REPORT COVER?');
    log('   Held against each property\'s monthly rent from the rent roll.');
    const af = require('../appfolio-reports.js');
    const rr = (((await af.readReportData('rent_roll')) || {}).rows) || [];
    const monthly = {};
    rr.forEach(r => {
      const p = PA.canonical(r.property_name || r.property);
      const v = C.num(r.rent);
      if (p && v) monthly[p] = (monthly[p] || 0) + v;
    });
    payload.filter(r => r.property !== C.PORTFOLIO).forEach(r => {
      const chk = C.periodCheck(r.rent_income, monthly[r.property], today);
      log('   ' + pad(r.property, 24) + pad(money(r.rent_income), 12)
        + 'of ' + pad(money(monthly[r.property]), 12)
        + (chk ? '= ' + chk.ratio + '   ' + chk.note : 'no rent roll figure'));
    });
    log('   THIS IS A CHECK, NOT A VERDICT — read it and decide.');
  }

  const accountNames = new Set();
  payload.forEach(r => Object.keys(r.accounts).forEach(k => accountNames.add(k)));
  log('');
  log('INCOME LINES SEEN (these are what "cash receipts" has to be chosen from):');
  [...accountNames].sort().forEach(n => log('   ' + n));
  log('   All of them are stored whole, so the definition can change without');
  log('   re-syncing. rent_income is denormalised because it is what the');
  log('   comparison currently uses.');

  if (DRY) {
    log('DRY RUN — nothing written.');
    return { captured: payload.length, written: 0, day: today };
  }

  const { error } = await db.from('collections_mtd')
    .upsert(payload, { onConflict: 'captured_on,property' });
  if (error) throw new Error(error.message);
  log('stored: ' + payload.length + ' rows for ' + today);
  return { captured: payload.length, written: payload.length, day: today };
}

module.exports = { syncCollectionsMtd };

if (require.main === module) {
  syncCollectionsMtd({
    dryRun: process.argv.includes('--dry-run'),
    explain: process.argv.includes('--explain'),
  }).catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
}
