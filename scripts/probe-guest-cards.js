#!/usr/bin/env node
//
// READ ONLY. Run on Render Shell.
//
//   node scripts/probe-guest-cards.js
//
// Reads reports only. Nothing is written to AppFolio, to Supabase or to disk,
// and no saved report is created or changed. Rate limited: Retry-After
// honoured, exponential backoff when absent, a fixed pause between every call.
//
// THE QUESTION. Lyndsay's "guest card interests" sheet holds 115 rows for
// 09/20-09/26. leasing_leads holds 68 for the same week, and the gap is two
// things: 34 of her rows are the same person at the same property appearing
// more than once, and 13 are not in our table at all.
//
// Her sheet's own filter line names the shape we are missing:
//
//     Property Groups: All Active, Source: All, STATUS: ALL, Lead Type: All,
//     Assigned User: All, Lisa Leads: All, Base Report: Guest Card Interests
//
// Two things to find out, and they are separate:
//
//   (1) Does guest_cards accept a status parameter? Our sync sends
//       property_visibility: 'active' and no status at all. If the report
//       defaults to active cards only, that is the 13 — and "Status: All"
//       would be the whole fix.
//
//   (2) Does it return ONE ROW PER INTEREST, or one per card? Her 115 against
//       81 unique person+property pairs says her report is per interest. If
//       guest_cards only ever returns one row per card, no parameter will
//       reproduce her number and the combined report needs its own table.
//
// The test is a count, not an opinion: 115 for the week, or not.

require('dotenv').config();

const ID = process.env.APPFOLIO_REPORTS_CLIENT_ID;
const SECRET = process.env.APPFOLIO_REPORTS_CLIENT_SECRET;
const HOST = process.env.APPFOLIO_REPORTS_HOST || 'metricpropertymanagement.appfolio.com';
const PATH = '/api/v2/reports/guest_cards.json';
const FROM = '2026-09-20', TO = '2026-09-26';
const HERS = 115;
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
    if (!r.ok) return { error: `${r.status} ${txt.slice(0, 150).replace(/\s+/g, ' ')}` };
    try {
      const j = JSON.parse(txt);
      return { rows: Array.isArray(j) ? j : (j.results || j.data || []) };
    } catch { return { error: 'not JSON' }; }
  }
  return { error: 'gave up — still rate limited' };
}

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function summarise(rows) {
  const inWeek = rows.filter(r => {
    const d = String(r.interest_received || r.received_on || r.inquiry_received || '').slice(0, 10);
    return d >= FROM && d <= TO;
  });
  const pairs = new Set(inWeek.map(r => norm(r.name) + '|' + norm(r.property_name || r.property)));
  return { total: rows.length, week: inWeek.length, unique: pairs.size };
}

(async () => {
  if (!ID || !SECRET) {
    console.error('APPFOLIO_REPORTS_CLIENT_ID / _SECRET are not set here. Run on Render Shell.');
    process.exit(1);
  }
  console.log('READ ONLY. Nothing is written anywhere.');
  console.log(`Target: ${HERS} rows for ${FROM}..${TO} (Lyndsay's sheet)\n`);

  const BASE = { interest_received_from: FROM, interest_received_to: TO, property_visibility: 'active' };

  // What our sync asks for today, as the baseline to beat.
  console.log('='.repeat(76));
  console.log('baseline — what the sync sends today');
  console.log('='.repeat(76));
  const base = await call({ first_contact_date_from: FROM, first_contact_date_to: TO, property_visibility: 'active' }, 'baseline');
  if (base.error) console.log('  ' + base.error);
  else {
    const s = summarise(base.rows);
    console.log(`  ${s.total} rows · ${s.week} in week · ${s.unique} unique person+property`);
    console.log(`  fields: ${Object.keys(base.rows[0] || {}).join(', ')}`);
  }

  // ── (1) can inactive cards be included? ───────────────────────────────────
  console.log('\n' + '='.repeat(76));
  console.log('(1) does a status parameter widen it?');
  console.log('='.repeat(76));
  const STATUS_TRIES = [
    ['no status (control)', {}],
    ['status: all', { status: 'all' }],
    ['statuses: all', { statuses: 'all' }],
    ['guest_card_status: all', { guest_card_status: 'all' }],
    ['status: All', { status: 'All' }],
    ['include_inactive: true', { include_inactive: true }],
    ['property_visibility: all', { property_visibility: 'all' }],
    ['no property_visibility', { property_visibility: undefined }],
  ];
  const seen = [];
  for (const [label, extra] of STATUS_TRIES) {
    const body = Object.assign({}, BASE, extra);
    Object.keys(body).forEach(k => body[k] === undefined && delete body[k]);
    const r = await call(body, label);
    if (r.error) { console.log(`  ${label.padEnd(26)} ${r.error.slice(0, 50)}`); continue; }
    const s = summarise(r.rows);
    seen.push({ label, ...s });
    const verdict = s.week === HERS ? '   <<< MATCHES HER 115'
      : s.week > (seen[0] ? seen[0].week : 0) ? '   wider than the control' : '';
    console.log(`  ${label.padEnd(26)} ${String(s.week).padStart(4)} in week · ${String(s.unique).padStart(4)} unique${verdict}`);
  }
  // A parameter AppFolio does not recognise is ignored silently, so "same
  // number as the control" means "did nothing", not "status is already all".
  const control = seen.find(s => /control/.test(s.label));
  const widened = seen.filter(s => control && s.week > control.week);
  console.log(widened.length
    ? `\n  ${widened.length} parameter(s) widened the result — the status filter is real.`
    : '\n  Nothing widened it. Either every card is already included, or none of');
  if (!widened.length) console.log('  these parameter names is recognised — AppFolio ignores unknown ones silently.');

  // ── (2) one row per interest, or per card? ────────────────────────────────
  console.log('\n' + '='.repeat(76));
  console.log('(2) one row per INTEREST, or per card?');
  console.log('='.repeat(76));
  const best = seen.slice().sort((a, b) => b.week - a.week)[0];
  if (!best) console.log('  no successful call to judge from');
  else {
    console.log(`  best result: ${best.week} rows in week, ${best.unique} unique person+property`);
    if (best.week > best.unique) {
      console.log(`  ${best.week - best.unique} rows are repeats of a person+property pair —`);
      console.log('  so the report DOES return one row per interest event.');
      console.log(best.week === HERS
        ? '  AND it matches her 115. The sync can be repointed at this.'
        : `  but it is ${best.week}, not ${HERS}. Something else still differs.`);
    } else {
      console.log('  Every row is a distinct person+property: this report returns one row');
      console.log('  per CARD, not per interest. No parameter will reproduce her 115, and');
      console.log('  the combined report needs its own per-interest table.');
    }
  }
  console.log('\nDone. Nothing was written.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
