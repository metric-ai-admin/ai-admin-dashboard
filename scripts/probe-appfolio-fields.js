#!/usr/bin/env node
//
// READ ONLY probe. Run on Render Shell, where the AppFolio credentials live.
//
//   node scripts/probe-appfolio-fields.js
//
// It only reads reports. Nothing is written to AppFolio, to Supabase or to
// disk, and no saved report is created, changed or deleted.
//
// RATE LIMITED ON PURPOSE. The previous run died on a 429 partway through and
// the answer it was looking for was in the part that never ran. Every call
// honours Retry-After, backs off, and there is a fixed pause between calls
// whether or not anything complained. It is slower than it needs to be on a
// good day, and it finishes on a bad one — which is the trade worth making for
// a probe you have to ask somebody else to run.
//
// THREE QUESTIONS:
//
// (a) rental_applications — which raw field carries "Converting"? Lyndsay's
//     workbook shows the report returns two status columns: "Status" (Converted
//     96, Converting 8, Approved 5, Denied 5, Canceled 12, Decision Pending 9,
//     In Screening 1) and "Application Status" (the rolled-up values only). Our
//     sync maps r.application_status, the second one, so "Converting" has never
//     reached leasing_applications and Vacant Rented cannot be computed.
//     Migration 075 added detailed_status to hold it; this says what to map.
//
// (b) unit_turn_detail — does it carry the week's move-outs? unit_vacancy does,
//     but only for units still vacant at sync time. If unit_turn_detail holds
//     them regardless, it is the better source. The test is the three in
//     Lyndsay's box score for 09/20-09/26: Ascent at Northgate 5-127, Hyde Park
//     Square 107, iConic Round Rock 106.
//
// (c) income_statement — can it answer the MTD financials? Those are the only
//     part of her report we have no source for. Two things decide it: whether
//     it takes a date range, and whether it breaks down by property.

require('dotenv').config();

const ID = process.env.APPFOLIO_REPORTS_CLIENT_ID;
const SECRET = process.env.APPFOLIO_REPORTS_CLIENT_SECRET;
const HOST = process.env.APPFOLIO_REPORTS_HOST || 'metricpropertymanagement.appfolio.com';
const WEEK = ['2026-09-20', '2026-09-26'];
const PAUSE_MS = 2500;          // between every call, always
const MAX_RETRIES = 5;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const inWeek = d => { const s = String(d || '').slice(0, 10); return s >= WEEK[0] && s <= WEEK[1]; };

// The three move-outs Lyndsay's box score has for that week.
const EXPECTED = [
  { property: 'Ascent at Northgate', unit: '5-127', date: '2026-09-21' },
  { property: 'Hyde Park Square', unit: '107', date: '2026-09-23' },
  { property: 'iConic Round Rock', unit: '106', date: '2026-09-25' },
];

async function call(path, body, method) {
  const auth = 'Basic ' + Buffer.from(`${ID}:${SECRET}`).toString('base64');
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const r = await fetch(`https://${HOST}${path}`, {
      method: method || 'POST',
      headers: Object.assign({ Authorization: auth },
        (method || 'POST') === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      body: (method || 'POST') === 'POST' ? JSON.stringify(body || {}) : undefined,
    });

    if (r.status === 429 || r.status === 503 || r.status === 502) {
      // Retry-After is the server telling us how long; believe it rather than
      // guessing, and fall back to exponential backoff when it is absent.
      const ra = Number(r.headers.get('retry-after'));
      const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(60000, 3000 * Math.pow(2, attempt));
      console.log(`    ${r.status} — waiting ${Math.round(wait / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES + 1})`);
      await sleep(wait);
      continue;
    }

    const txt = await r.text();
    await sleep(PAUSE_MS);                 // the fixed pause, success or not
    if (!r.ok) return { status: r.status, error: txt.slice(0, 200).replace(/\s+/g, ' ') };
    try {
      const j = JSON.parse(txt);
      return { status: r.status, rows: Array.isArray(j) ? j : (j.results || j.data || []), raw: j };
    } catch { return { status: r.status, error: 'response was not JSON' }; }
  }
  return { error: `gave up after ${MAX_RETRIES + 1} attempts (still rate limited)` };
}

const distinct = (rows, field) => {
  const m = {};
  rows.forEach(r => { const v = String(r[field] ?? '').trim(); if (v) m[v] = (m[v] || 0) + 1; });
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
};

(async () => {
  if (!ID || !SECRET) {
    console.error('APPFOLIO_REPORTS_CLIENT_ID / _SECRET are not set here.');
    console.error('Run this on Render Shell, not a laptop.');
    process.exit(1);
  }
  console.log('READ ONLY. Nothing is written anywhere.');
  console.log(`Host  : ${HOST}`);
  console.log(`Week  : ${WEEK[0]} .. ${WEEK[1]}`);
  console.log(`Pause : ${PAUSE_MS}ms between calls, Retry-After honoured on 429\n`);

  // ── (a) rental_applications ───────────────────────────────────────────────
  console.log('='.repeat(78));
  console.log('(a) rental_applications — which field holds "Converting"?');
  console.log('='.repeat(78));
  const ra = await call('/api/v2/reports/rental_applications.json',
    { property_visibility: 'active', paginate_results: true });
  if (ra.error) console.log(`  ${ra.status || ''} ${ra.error}`);
  else {
    console.log(`  ${ra.rows.length} rows`);
    const fields = Object.keys(ra.rows[0] || {});
    console.log(`\n  RAW FIELD NAMES (${fields.length}):`);
    fields.forEach(f => console.log(`    ${f}`));
    console.log('\n  every field that holds an application state:');
    let found = null;
    fields.forEach(f => {
      const vals = distinct(ra.rows, f);
      if (!vals.length) return;
      const looksLikeStatus = vals.some(([v]) => /^(converting|converted|approved|denied|canceled|cancelled|decision pending|in screening)$/i.test(v));
      if (!looksLikeStatus) return;
      const hasConverting = vals.some(([v]) => /^converting$/i.test(v));
      if (hasConverting) found = f;
      console.log(`\n    ${f}${hasConverting ? '   <<< HAS "Converting" — map THIS into detailed_status' : ''}`);
      vals.slice(0, 10).forEach(([v, n]) => console.log(`        ${v} = ${n}`));
    });
    console.log(found
      ? `\n  ANSWER: map r.${found} into leasing_applications.detailed_status.`
      : '\n  ANSWER: no field holds "Converting" — the API returns less than the saved report.');
  }

  // ── (b) unit_turn_detail ──────────────────────────────────────────────────
  console.log('\n' + '='.repeat(78));
  console.log('(b) unit_turn_detail — does it carry the week\'s move-outs?');
  console.log('='.repeat(78));
  const ut = await call('/api/v2/reports/unit_turn_detail.json',
    { property_visibility: 'active', paginate_results: true });
  if (ut.error) console.log(`  ${ut.status || ''} ${ut.error}`);
  else {
    console.log(`  ${ut.rows.length} rows`);
    const fields = Object.keys(ut.rows[0] || {});
    console.log(`\n  RAW FIELD NAMES (${fields.length}):`);
    fields.forEach(f => console.log(`    ${f}`));
    const dateFields = fields.filter(f => /move_?out|moved|vacat|turn|notice|date/i.test(f));
    console.log('\n  date-ish fields and how many fall in the week:');
    dateFields.forEach(f => {
      const n = ut.rows.filter(r => inWeek(r[f])).length;
      const pop = ut.rows.filter(r => r[f]).length;
      console.log(`    ${f.padEnd(30)} ${String(n).padStart(4)} in week   ${String(pop).padStart(5)} populated`);
    });
    // The real test: are Lyndsay's three in there?
    const moveOutField = dateFields.find(f => /move_?out/i.test(f)) || dateFields[0];
    if (moveOutField) {
      console.log(`\n  checking Lyndsay's three against ${moveOutField}:`);
      EXPECTED.forEach(e => {
        const hit = ut.rows.find(r =>
          String(r.property_name || r.property || '').includes(e.property.split(' ')[0])
          && String(r.unit || r.unit_name || '').trim() === e.unit
          && inWeek(r[moveOutField]));
        console.log(`    ${e.property.padEnd(22)} ${e.unit.padEnd(8)} ${e.date}   ${hit ? 'FOUND' : 'missing'}`);
      });
      console.log('\n  Three out of three means this is a better source than unit_vacancy,');
      console.log('  because it should keep a move-out after the unit is re-rented.');
    }
  }

  // ── (c) income_statement ──────────────────────────────────────────────────
  console.log('\n' + '='.repeat(78));
  console.log('(c) income_statement — MTD range, and per property?');
  console.log('='.repeat(78));
  const BODIES = [
    ['no filters', { property_visibility: 'active', paginate_results: true }],
    ['MTD range', { from_date: '2026-09-01', to_date: '2026-09-26', property_visibility: 'active', paginate_results: true }],
    ['posted_on range', { posted_on_from: '2026-09-01', posted_on_to: '2026-09-26', property_visibility: 'active', paginate_results: true }],
    ['accounting basis', { from_date: '2026-09-01', to_date: '2026-09-26', accounting_basis: 'Cash', property_visibility: 'active', paginate_results: true }],
  ];
  let shownFields = false;
  for (const [label, body] of BODIES) {
    const r = await call('/api/v2/reports/income_statement.json', body);
    if (r.error) { console.log(`  ${label.padEnd(18)} ${r.status || ''} ${r.error.slice(0, 80)}`); continue; }
    console.log(`  ${label.padEnd(18)} ${r.rows.length} rows`);
    if (!shownFields && r.rows.length) {
      shownFields = true;
      const fields = Object.keys(r.rows[0]);
      console.log(`\n  RAW FIELD NAMES (${fields.length}):`);
      fields.forEach(f => console.log(`    ${f}`));
      // Per property, or one column of totals? That is what decides whether it
      // can replace the MTD Cash / MTD Accrual sheets, which are per property.
      const propField = fields.find(f => /property/i.test(f));
      if (propField) {
        const props = distinct(r.rows, propField);
        console.log(`\n  breaks down by ${propField}: ${props.length} distinct value(s)`);
        props.slice(0, 12).forEach(([v, n]) => console.log(`        ${v} = ${n} rows`));
      } else {
        console.log('\n  NO property field — this returns portfolio totals only,');
        console.log('  and her report needs it per property.');
      }
      console.log('\n  sample row:');
      console.log('    ' + JSON.stringify(r.rows[0]).slice(0, 400));
    }
  }

  console.log('\n' + '='.repeat(78));
  console.log('Done. Nothing was written.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
