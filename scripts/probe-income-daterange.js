#!/usr/bin/env node
//
// Does posted_on_from / posted_on_to accept DAYS, not just months?
// READ ONLY — report reads, nothing written anywhere.
//
//   node scripts/probe-income-daterange.js
//
// WHY IT MATTERS. With months, October is all we can ask for, so "collections
// down vs the same stretch of last month" needs a history we accumulate and a
// seed from Katie's workbooks, and it starts answering on 5 November. With
// DAYS, the question is two API calls — 1st to the 15th of this month against
// 1st to the 15th of last — and it answers correctly tomorrow, from data
// AppFolio already has. The daily capture still earns its place as our own
// record, but the alert stops depending on it.
//
// THE TRAP THIS IS BUILT AROUND. The obvious test — ask for 2026-10-01 to
// 2026-10-15 and check it equals the month figure — PASSES BOTH WAYS. If the
// day parts are ignored and the values are read as October, the answer is the
// month total, which is exactly what a working day range would return today,
// the 15th. It would look like proof and be worth nothing. The same shape of
// mistake has now cost five probes on this endpoint.
//
// So the decisive test is a SHORT range:
//
//   2026-10-01 to 2026-10-10 must come back STRICTLY LESS than the month.
//
// Equal means the days are being ignored. Only after that does the full-stretch
// check mean anything.
require('dotenv').config();

const C = require('../lib/collections-mtd.js');

const ID = process.env.APPFOLIO_REPORTS_CLIENT_ID;
const SECRET = process.env.APPFOLIO_REPORTS_CLIENT_SECRET;
const HOST = process.env.APPFOLIO_REPORTS_HOST || 'metricpropertymanagement.appfolio.com';

const REPORT = 'income_statement_comparison';
const LIST_ID = process.env.PROBE_LIST_ID || 'l_32';
const ASCENT_ID = process.env.PROBE_PROPERTY_ID || '1703';

// Verified against the AppFolio saved report on 2026-10-15.
const OCT_TOTAL = Number(process.env.PROBE_TARGET_TOTAL || 278803.67);
const OCT_ASCENT = Number(process.env.PROBE_TARGET_ASCENT || 43055.01);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = (s, w) => String(s).padEnd(w);
const money = n => (n === null || n === undefined ? '—'
  : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const eq = (a, b) => a !== null && a !== undefined && b !== null && Math.abs(a - b) < 0.005;

async function ask(from, to, attempt) {
  const r = await global.fetch('https://' + HOST + '/api/v2/reports/' + REPORT + '.json', {
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
      posted_on_from: from,
      posted_on_to: to,
    }),
  });
  if (r.status === 429) {
    const n = (attempt || 0) + 1;
    if (n > 5) throw new Error('rate limited five times');
    const wait = Number(r.headers.get('retry-after')) || 30;
    console.log('   (rate limited, waiting ' + wait + 's)');
    await sleep(wait * 1000);
    return ask(from, to, n);
  }
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch (e) { /* not json */ }
  const rows = Array.isArray(j) ? j : ((j && (j.results || j.data)) || []);
  const rent = rows.find(x => /^rent income$/i.test(String(x.account_name || '').trim()));
  return {
    status: r.status,
    err: r.ok ? null : String((j && (j.error || j.message)) || text).slice(0, 120),
    total: rent ? C.num(rent.total) : null,
    ascent: rent ? (C.breakdown(rent.properties).map[String(ASCENT_ID)] ?? null) : null,
  };
}

async function show(label, from, to) {
  const r = await ask(from, to);
  console.log('   ' + pad(label, 34) + pad(money(r.total), 18) + 'Ascent ' + money(r.ascent)
    + (r.status >= 400 ? '   HTTP ' + r.status + ': ' + (r.err || '') : ''));
  await sleep(800);
  return r;
}

(async () => {
  if (!ID || !SECRET) {
    console.error('APPFOLIO_REPORTS_CLIENT_ID / _SECRET are not set here. Run on Render Shell.');
    process.exitCode = 1;
    return;
  }
  console.log('READ ONLY. ' + REPORT + ' only. Nothing is written anywhere.\n');

  // ---- the control ----------------------------------------------------------
  console.log('CONTROL — the month format, which is known to work');
  const oct = await show('2026-10', '2026-10', '2026-10');
  const ok = eq(oct.total, OCT_TOTAL) && eq(oct.ascent, OCT_ASCENT);
  console.log('   ' + (ok
    ? 'matches the saved report exactly. The rest can be trusted.'
    : 'DOES NOT match ' + money(OCT_TOTAL) + ' / ' + money(OCT_ASCENT)
      + '. Either the figures moved during the day, or something changed.'
      + '\n   Read the rest with that in mind.'));

  // ---- (a) September, whole month -------------------------------------------
  console.log('\n(a) SEPTEMBER, whole month');
  const sep = await show('2026-09', '2026-09', '2026-09');
  if (sep.total !== null && !eq(sep.total, oct.total)) {
    console.log('   A different figure from October, so the month parameter really');
    console.log('   selects the month. September is readable from the API.');
  } else if (eq(sep.total, oct.total)) {
    console.log('   IDENTICAL TO OCTOBER. That is not two months agreeing to the cent —');
    console.log('   it means the value is being ignored. Stop; nothing below is valid.');
  }

  // ---- (b) the decisive test ------------------------------------------------
  console.log('\n(b) DO DAYS WORK? The short range decides it.');
  console.log('    2026-10-01..10 must be STRICTLY LESS than the month. If it comes');
  console.log('    back equal, the day parts are being ignored and read as October.');
  const short = await show('2026-10-01 .. 2026-10-10', '2026-10-01', '2026-10-10');

  let daysWork = false;
  if (short.status >= 400) {
    console.log('   REJECTED. Days are not accepted in this parameter.');
  } else if (short.total === null) {
    console.log('   No figure came back. Days are not usable here.');
  } else if (eq(short.total, oct.total)) {
    console.log('   EQUAL TO THE WHOLE MONTH — the day parts are ignored. This is the');
    console.log('   trap: it would have looked like success against the 15th.');
  } else if (short.total > oct.total) {
    console.log('   LARGER than the month, which cannot be a sub-range of it. Whatever');
    console.log('   this is, it is not what was asked for.');
  } else {
    daysWork = true;
    console.log('   LESS than the month, by ' + money(oct.total - short.total)
      + '. The day parts are real.');
  }

  if (daysWork) {
    console.log('\n   The rest of (b), now that it means something:');
    const octStretch = await show('2026-10-01 .. 2026-10-15', '2026-10-01', '2026-10-15');
    const sepStretch = await show('2026-09-01 .. 2026-09-15', '2026-09-01', '2026-09-15');

    console.log('\n   CHECK 1 — the October stretch against the month, today being the 15th');
    console.log('      ' + (eq(octStretch.total, oct.total)
      ? 'EQUAL. Consistent: month-to-date on the 15th IS the 1st to the 15th.'
      : 'DIFFERENT by ' + money(Math.abs((octStretch.total || 0) - (oct.total || 0)))
        + '. Worth understanding before using either — a receipt posted today, '
        + 'or a boundary that is exclusive at one end.'));

    console.log('   CHECK 2 — the September stretch against the September month');
    console.log('      ' + (sepStretch.total !== null && sep.total !== null
      ? (sepStretch.total < sep.total
        ? 'LESS, as a half month should be. ' + money(sepStretch.total)
          + ' of ' + money(sep.total)
        : 'NOT less than the whole month. Something is wrong with one of them.')
      : 'a figure is missing'));

    console.log('\nWHAT THIS MEANS');
    console.log('   The alert can be computed directly: 1st to the Nth of this month');
    console.log('   against 1st to the Nth of last, two calls, no history and no seed.');
    console.log('   It answers correctly tomorrow rather than on 5 November, and it is');
    console.log('   right the first time instead of becoming right as rows accumulate.');
    console.log('   The daily capture still earns its place — a record of what we saw,');
    console.log('   on the day we saw it, which a live query cannot reconstruct — but');
    console.log('   the alert stops depending on it.');
  } else {
    console.log('\nWHAT THIS MEANS');
    console.log('   Months only. The alert needs our own history after all: the daily');
    console.log('   capture plus October seeded from Katie\'s workbooks, answering from');
    console.log('   5 November. That is the plan already built — nothing is wasted.');
    console.log('   September IS readable as a whole month, so a month-against-month');
    console.log('   comparison is possible now; it just is not the same stretch, and');
    console.log('   a part-month against a whole one would show every property down.');
  }

  console.log('\nNothing was written.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
