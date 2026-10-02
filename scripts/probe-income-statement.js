#!/usr/bin/env node
//
// READ ONLY. Run on Render Shell.
//
//   node scripts/probe-income-statement.js
//
// It only reads reports. Nothing is written anywhere and no saved report is
// touched. Rate limited the same way as the field probe: Retry-After honoured,
// exponential backoff when it is absent, a fixed pause between every call.
//
// WHAT THIS DECIDES. income_statement returned 309 rows for all four filter
// bodies — identical counts — which looks like a report that ignores its
// filters and answers portfolio totals. If that is true it cannot replace the
// MTD Cash and MTD Accrual sheets, which Lyndsay's report reads per property,
// and the MTD financials stay on Katie's workbook.
//
// But identical ROW COUNTS are not identical NUMBERS, and "no property column"
// is not the same as "cannot be filtered to one property". Two questions
// settle it, and neither was asked:
//
//   1. Does it accept a property filter? Ask for ONE property by id and compare
//      its Rent Income against the portfolio figure. A smaller number means the
//      filter works and we can loop properties; the same number means it does
//      not and the report is portfolio-only.
//
//   2. Does the date filter do anything? Ask for two clearly different windows
//      and compare the VALUES, not the row counts. September month-to-date and
//      a single day in January cannot honestly produce the same Rent Income.
//
// A report that silently ignores an unrecognised parameter is exactly how a
// wrong number gets into a report nobody questions — AppFolio does this, and it
// is why this asks rather than assumes.

require('dotenv').config();

const ID = process.env.APPFOLIO_REPORTS_CLIENT_ID;
const SECRET = process.env.APPFOLIO_REPORTS_CLIENT_SECRET;
const HOST = process.env.APPFOLIO_REPORTS_HOST || 'metricpropertymanagement.appfolio.com';
const PATH = '/api/v2/reports/income_statement.json';
const PAUSE_MS = 2500;
const MAX_RETRIES = 5;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function call(body, label) {
  const auth = 'Basic ' + Buffer.from(`${ID}:${SECRET}`).toString('base64');
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const r = await fetch(`https://${HOST}${PATH}`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.status === 429 || r.status === 503 || r.status === 502) {
      const ra = Number(r.headers.get('retry-after'));
      const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(60000, 3000 * Math.pow(2, attempt));
      console.log(`    ${label}: ${r.status} — waiting ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      continue;
    }
    const txt = await r.text();
    await sleep(PAUSE_MS);
    if (!r.ok) return { error: `${r.status} ${txt.slice(0, 160).replace(/\s+/g, ' ')}` };
    try {
      const j = JSON.parse(txt);
      return { rows: Array.isArray(j) ? j : (j.results || j.data || []) };
    } catch { return { error: 'not JSON' }; }
  }
  return { error: 'gave up — still rate limited' };
}

const num = v => {
  const n = Number(String(v == null ? '' : v).replace(/[$,()\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};
// The figure to compare: the Rent Income line's value, whatever the value
// column turns out to be called.
function rentIncome(rows) {
  const row = rows.find(r => Object.values(r).some(v => /^rent income$/i.test(String(v || '').trim())));
  if (!row) return { line: null, values: {} };
  const values = {};
  Object.entries(row).forEach(([k, v]) => { const n = num(v); if (n !== null && n !== 0) values[k] = n; });
  return { line: row, values };
}

(async () => {
  if (!ID || !SECRET) {
    console.error('APPFOLIO_REPORTS_CLIENT_ID / _SECRET are not set here. Run on Render Shell.');
    process.exit(1);
  }
  console.log('READ ONLY. Nothing is written anywhere.\n');

  // Baseline: the portfolio answer the previous probe already saw.
  console.log('='.repeat(76));
  console.log('baseline — no property filter, September MTD');
  console.log('='.repeat(76));
  const base = await call({ from_date: '2026-09-01', to_date: '2026-09-26', property_visibility: 'active', paginate_results: true }, 'baseline');
  if (base.error) { console.log('  ' + base.error); process.exit(1); }
  console.log(`  ${base.rows.length} rows`);
  const fields = Object.keys(base.rows[0] || {});
  console.log(`  fields: ${fields.join(', ')}`);
  const baseRent = rentIncome(base.rows);
  console.log('  Rent Income line:');
  console.log('    ' + JSON.stringify(baseRent.line).slice(0, 300));

  // ── 1. one property ───────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(76));
  console.log('1. does a property filter work?');
  console.log('='.repeat(76));
  console.log('  property ids come from leasing_occupancy / unit_vacancy; set PROBE_PROPERTY_ID');
  console.log('  to try a specific one. Otherwise these common parameter names are tried.\n');
  const pid = process.env.PROBE_PROPERTY_ID || '';
  const PROP_BODIES = [
    ['properties_ids', { 'filters[properties_ids][0]': pid }],
    ['property_ids', { property_ids: [pid] }],
    ['property_id', { property_id: pid }],
    ['properties', { properties: [pid] }],
  ];
  if (!pid) {
    console.log('  PROBE_PROPERTY_ID not set — skipping. Re-run as:');
    console.log('    PROBE_PROPERTY_ID=<id> node scripts/probe-income-statement.js');
  } else {
    for (const [label, extra] of PROP_BODIES) {
      const r = await call(Object.assign(
        { from_date: '2026-09-01', to_date: '2026-09-26', property_visibility: 'active', paginate_results: true },
        extra), label);
      if (r.error) { console.log(`  ${label.padEnd(16)} ${r.error.slice(0, 60)}`); continue; }
      const ri = rentIncome(r.rows);
      const same = JSON.stringify(ri.values) === JSON.stringify(baseRent.values);
      console.log(`  ${label.padEnd(16)} ${String(r.rows.length).padStart(4)} rows · Rent Income ${JSON.stringify(ri.values).slice(0, 80)}`);
      console.log(`  ${''.padEnd(16)} ${same ? 'SAME as portfolio — the filter was ignored' : 'DIFFERENT — the filter works'}`);
    }
  }

  // ── 2. does the date filter do anything? ──────────────────────────────────
  console.log('\n' + '='.repeat(76));
  console.log('2. does the date filter change the numbers?');
  console.log('='.repeat(76));
  const WINDOWS = [
    ['Sep 1-26 2026', { from_date: '2026-09-01', to_date: '2026-09-26' }],
    ['Jan 1-2 2026', { from_date: '2026-01-01', to_date: '2026-01-02' }],
    ['Sep 2025 only', { from_date: '2025-09-01', to_date: '2025-09-30' }],
  ];
  const seen = [];
  for (const [label, win] of WINDOWS) {
    const r = await call(Object.assign({ property_visibility: 'active', paginate_results: true }, win), label);
    if (r.error) { console.log(`  ${label.padEnd(16)} ${r.error.slice(0, 60)}`); continue; }
    const ri = rentIncome(r.rows);
    seen.push({ label, rows: r.rows.length, values: JSON.stringify(ri.values) });
    console.log(`  ${label.padEnd(16)} ${String(r.rows.length).padStart(4)} rows · Rent Income ${String(ri.values && JSON.stringify(ri.values)).slice(0, 90)}`);
  }
  const distinctValues = new Set(seen.map(s => s.values));
  console.log('');
  if (distinctValues.size <= 1 && seen.length > 1) {
    console.log('  ALL WINDOWS RETURNED THE SAME NUMBERS — the date filter is ignored.');
    console.log('  A report that answers the same thing for September 2026 and two days');
    console.log('  in January is not answering the question being asked, and cannot be');
    console.log('  used for MTD.');
  } else {
    console.log('  The windows differ, so the date filter is honoured.');
  }

  console.log('\nDone. Nothing was written.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
