#!/usr/bin/env node
//
// Which parameter sets the PERIOD on income_statement_comparison?
// READ ONLY — report reads, nothing written anywhere.
//
//   node scripts/probe-income-period.js
//
// WHAT WENT WRONG, and it is worth writing down because it survived four
// rounds of probing. Every figure the API returned was for A DIFFERENT PERIOD
// than the one we were comparing it against, and nothing in the response says
// so. Arturo opened the saved report in AppFolio on 2026-10-15:
//
//   AppFolio, Oct 2026 to Oct 2026:   total 278,803.67   Ascent 43,055.01
//   the API, default period:          total 311,166.40   Ascent 56,335.98
//
// So the default is some other period — most likely September, a full month,
// which also explains the original anomaly that started all of this: Ascent
// "collecting more than it bills" was a FULL MONTH of receipts being held
// against a month that was 47% elapsed. The accrual theory was an explanation
// invented to fit one ratio, and the cash-under-accrual check was a rule
// applied across two different periods, where it proves nothing.
//
// THE TARGET IS EXACT. 278,803.67 total, 43,055.01 Ascent. Not "close", not
// "consistent with" — a parameter that is accepted and ignored returns a
// plausible number every single time, and plausible is what has cost four
// probes. If it does not match to the cent, it has not been found.
//
// (A later run may be slightly HIGHER: more receipts land during the day.
// Higher by a little is expected; different is not.)
//
// THE SEARCH IS STAGED so it does not spend a hundred calls guessing:
//   A. which NAME is live at all — one value, every candidate name
//   B. for a live name, which VALUE FORMAT reproduces the number
//   C. the modifiers: period_basis, and the nested shape properties needed
require('dotenv').config();

const C = require('../lib/collections-mtd.js');


const ID = process.env.APPFOLIO_REPORTS_CLIENT_ID;
const SECRET = process.env.APPFOLIO_REPORTS_CLIENT_SECRET;
const HOST = process.env.APPFOLIO_REPORTS_HOST || 'metricpropertymanagement.appfolio.com';

const REPORT = 'income_statement_comparison';
const LIST_ID = process.env.PROBE_LIST_ID || 'l_32';
const ASCENT_ID = process.env.PROBE_PROPERTY_ID || '1703';

// What AppFolio shows for October, read off the saved report on 2026-10-15.
const TARGET_TOTAL = Number(process.env.PROBE_TARGET_TOTAL || 278803.67);
const TARGET_ASCENT = Number(process.env.PROBE_TARGET_ASCENT || 43055.01);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = (s, w) => String(s).padEnd(w);
const money = n => (n === null || n === undefined ? '—'
  : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

async function call(extra, attempt) {
  const body = {
    property_visibility: 'active',
    paginate_results: false,
    accounting_basis: 'Cash',
    properties: { properties_ids: [LIST_ID] },
    ...extra,
  };
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
    console.log('      (rate limited, waiting ' + wait + 's)');
    await sleep(wait * 1000);
    return call(extra, n);
  }
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch (e) { /* not json */ }
  const rows = Array.isArray(j) ? j : ((j && (j.results || j.data)) || []);
  const err = r.ok ? null : String((j && (j.error || j.message)) || text).slice(0, 120);
  const rent = rows.find(x => /^rent income$/i.test(String(x.account_name || '').trim()));
  return {
    status: r.status,
    err,
    total: rent ? C.num(rent.total) : null,
    ascent: rent ? C.breakdown(rent.properties).map[String(ASCENT_ID)] ?? null : null,
  };
}

const eq = (a, b) => a !== null && a !== undefined && Math.abs(a - b) < 0.005;

function score(r) {
  if (r.status >= 400) return { tag: 'HTTP ' + r.status + (r.err ? ': ' + r.err : ''), hit: false };
  if (r.total === null) return { tag: 'no Rent Income line', hit: false };
  if (eq(r.total, TARGET_TOTAL) && eq(r.ascent, TARGET_ASCENT)) {
    return { tag: '*** EXACT — total AND Ascent ***', hit: true };
  }
  if (eq(r.total, TARGET_TOTAL)) return { tag: 'total matches, Ascent does NOT', hit: false };
  if (eq(r.ascent, TARGET_ASCENT)) return { tag: 'Ascent matches, total does NOT', hit: false };
  return { tag: '', hit: false };
}

// ---- A: which parameter name is live ----------------------------------------
//
// Every name gets the same value. A name that CHANGES the total is live; one
// that returns the default is being ignored, whatever it is called.
const NAMES = [
  'period_from', 'from_date', 'posted_on_from', 'date_from', 'start_date',
  'accounting_period_from', 'period', 'date_range',
];
const PAIRED = {
  period_from: 'period_to',
  from_date: 'to_date',
  posted_on_from: 'posted_on_to',
  date_from: 'date_to',
  start_date: 'end_date',
  accounting_period_from: 'accounting_period_to',
};

// ---- B: the value formats ---------------------------------------------------
//
// The saved report's Date Range reads "Oct 2026 to Oct 2026 (This Month)", so
// it thinks in MONTHS, not days. Day-shaped values are included anyway: the
// endpoint may accept both and we have been wrong about this report twice.
const FORMATS = [
  ['2026-10', '2026-10'],
  ['Oct 2026', 'Oct 2026'],
  ['10/2026', '10/2026'],
  ['2026-10-01', '2026-10-31'],
  ['10/01/2026', '10/31/2026'],
];
const RELATIVE = ['this_month', 'This Month', 'current_month'];

(async () => {
  if (!ID || !SECRET) {
    console.error('APPFOLIO_REPORTS_CLIENT_ID / _SECRET are not set here. Run on Render Shell.');
    process.exitCode = 1;
    return;
  }
  console.log('READ ONLY. ' + REPORT + ' only. Nothing is written anywhere.\n');
  console.log('TARGET (AppFolio, saved report, Oct 2026 to Oct 2026, Cash):');
  console.log('   total  ' + money(TARGET_TOTAL));
  console.log('   Ascent ' + money(TARGET_ASCENT));
  console.log('   Exact, to the cent. A plausible number is what four probes already bought.\n');

  const base = await call({});
  console.log('DEFAULT (no period parameter): total ' + money(base.total)
    + '   Ascent ' + money(base.ascent));
  console.log('   That is the number to BEAT. Anything equal to it is being ignored.\n');

  const winners = [];
  const live = [];

  // ---- A -------------------------------------------------------------------
  console.log('A. WHICH NAME IS LIVE?  (value "2026-10")');
  for (const name of NAMES) {
    const body = {};
    body[name] = '2026-10';
    if (PAIRED[name]) body[PAIRED[name]] = '2026-10';
    const r = await call(body);
    const s = score(r);
    const moved = r.status < 400 && r.total !== null && !eq(r.total, base.total);
    console.log('   ' + pad(name + (PAIRED[name] ? ' / ' + PAIRED[name] : ''), 44)
      + pad(money(r.total), 18) + (r.status >= 400 ? s.tag : (moved ? 'MOVED' : 'same as default'))
      + (s.hit ? '   ' + s.tag : ''));
    if (s.hit) winners.push({ what: name + ' = 2026-10', r });
    // A 500 means the name is RECOGNISED and the value is wrong — that is a
    // lead, not a dead end. It is how the property filter was found.
    if (moved || r.status === 500) live.push(name);
    await sleep(700);
  }

  // The relative keyword the UI shows in brackets.
  for (const rel of RELATIVE) {
    const r = await call({ period: rel });
    const s = score(r);
    const moved = r.status < 400 && r.total !== null && !eq(r.total, base.total);
    console.log('   ' + pad('period = "' + rel + '"', 44) + pad(money(r.total), 18)
      + (r.status >= 400 ? s.tag : (moved ? 'MOVED' : 'same as default')) + (s.hit ? '   ' + s.tag : ''));
    if (s.hit) winners.push({ what: 'period = ' + rel, r });
    await sleep(700);
  }

  if (!live.length && !winners.length) {
    console.log('\n   NO NAME MOVED THE NUMBER. Before guessing further: the saved report');
    console.log('   in AppFolio has a URL, and its filters[...] keys are the parameter');
    console.log('   names this endpoint actually takes — posted_on_relative_to and');
    console.log('   properties_ids both came from there. Read the Date Range filter off');
    console.log('   that URL rather than adding more names to this list.');
    console.log('\nNothing was written.');
    return;
  }

  // ---- B -------------------------------------------------------------------
  if (!winners.length) {
    console.log('\nB. WHICH VALUE FORMAT?  (live names: ' + [...new Set(live)].join(', ') + ')');
    for (const name of [...new Set(live)]) {
      for (const [from, to] of FORMATS) {
        const body = {};
        body[name] = from;
        if (PAIRED[name]) body[PAIRED[name]] = to;
        const r = await call(body);
        const s = score(r);
        console.log('   ' + pad(name + ' = "' + from + '"', 44) + pad(money(r.total), 18)
          + 'Ascent ' + pad(money(r.ascent), 16) + s.tag);
        if (s.hit) { winners.push({ what: name + ' = "' + from + '"', r }); break; }
        await sleep(700);
      }
      if (winners.length) break;
    }
  }

  // ---- C -------------------------------------------------------------------
  if (!winners.length) {
    console.log('\nC. MODIFIERS  (period_basis, and the nested shape properties needed)');
    const name = [...new Set(live)][0];
    const mods = [
      ['+ period_basis calendar', { period_basis: 'calendar' }],
      ['+ period_basis Calendar', { period_basis: 'Calendar' }],
      ['nested in filters', null],
    ];
    for (const [label, extra] of mods) {
      for (const [from, to] of FORMATS.slice(0, 3)) {
        let body;
        if (extra) {
          body = { ...extra };
          body[name] = from;
          if (PAIRED[name]) body[PAIRED[name]] = to;
        } else {
          const f = {};
          f[name] = from;
          if (PAIRED[name]) f[PAIRED[name]] = to;
          body = { filters: f };
        }
        const r = await call(body);
        const s = score(r);
        console.log('   ' + pad(label + '  "' + from + '"', 44) + pad(money(r.total), 18)
          + 'Ascent ' + pad(money(r.ascent), 16) + s.tag);
        if (s.hit) { winners.push({ what: label + ' with ' + name + ' = "' + from + '"', r }); break; }
        await sleep(700);
      }
      if (winners.length) break;
    }
  }

  // ---- the answer -----------------------------------------------------------
  console.log('\nVERDICT');
  if (!winners.length) {
    console.log('   Nothing reproduced ' + money(TARGET_TOTAL) + '. The period cannot be');
    console.log('   set through any name tried, and NOTHING SHOULD BE CAPTURED: the');
    console.log('   default period is not October, so a daily capture would build a');
    console.log('   history of the wrong month and the comparison would be meaningless.');
    console.log('   Next step is the saved report\'s URL, not more guesses.');
  } else {
    const w = winners[0];
    console.log('   ' + w.what);
    console.log('   total ' + money(w.r.total) + '   Ascent ' + money(w.r.ascent));
    console.log('   Both exact. This is the period AppFolio shows, and the sync can use it.');
    console.log('\n   One thing to settle before switching it on: with a working period');
    console.log('   parameter the API can be asked about SEPTEMBER too — which would');
    console.log('   mean no seeding from workbooks and a real comparison from 1 November.');
    console.log('   Worth one more run with the same parameter set to 2026-09.');
  }
  console.log('\nNothing was written.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
