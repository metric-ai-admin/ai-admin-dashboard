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

// The same parser the leasing sync uses (leasingDateOnly in server.js).
//
// The first version of this probe sliced the first ten characters off three
// field names that do not exist on this report — interest_received, received_on
// and inquiry_received. The field is `received`. Every row therefore produced
// an empty date, every comparison failed, and the probe reported "0 in week"
// for all eight variants including the control, which looked like a finding and
// was a bug. A 0 that agrees with itself everywhere is not evidence of
// anything.
const dateOnly = v => {
  if (v === '' || v == null) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toLocaleDateString('en-CA');
};

// A tolerant version, for finding out what the strict one is losing.
//
// AppFolio writes some timestamps as "09/21/2026 at 08:41 PM", and
// new Date() cannot read that — it returns Invalid Date, which dateOnly turns
// into null. If `received` is in that format then the SYNC has the same blind
// spot, silently, and the probe needs to say so rather than quietly agreeing
// with it. So both are measured: strict is what the sync sees, tolerant is
// what is really there.
const dateOnlyLoose = v => {
  if (v === '' || v == null) return null;
  const strict = dateOnly(v);
  if (strict) return strict;
  const s = String(v).replace(/\s+at\s+/i, ' ');
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toLocaleDateString('en-CA');
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(s);
  if (!m) return null;
  const y = m[3].length === 2 ? '20' + m[3] : m[3];
  return `${y}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
};

// The field name this report actually uses, from APPFOLIO_LEASING_FIELDS.
const receivedOf = r => dateOnly(r.received);
const receivedLoose = r => dateOnlyLoose(r.received);

function summarise(rows) {
  const inWeek = rows.filter(r => { const d = receivedOf(r); return !!d && d >= FROM && d <= TO; });
  const inWeekLoose = rows.filter(r => { const d = receivedLoose(r); return !!d && d >= FROM && d <= TO; });
  const pairs = new Set(inWeekLoose.map(r => norm(r.name) + '|' + norm(r.property_name || r.property)));
  // Rows that HAVE a received value the strict parser cannot read. If this is
  // not zero, the sync is dropping them too.
  const unreadable = rows.filter(r => r.received != null && String(r.received).trim() !== '' && !receivedOf(r)).length;
  return { total: rows.length, week: inWeek.length, weekLoose: inWeekLoose.length, unique: pairs.size, unreadable };
}

(async () => {
  if (!ID || !SECRET) {
    console.error('APPFOLIO_REPORTS_CLIENT_ID / _SECRET are not set here. Run on Render Shell.');
    process.exit(1);
  }
  console.log('READ ONLY. Nothing is written anywhere.');
  console.log(`Target: ${HERS} rows for ${FROM}..${TO} (Lyndsay's sheet)\n`);

  // No date filter sent. The week is counted LOCALLY off `received`, so the
  // status question is not entangled with whether AppFolio recognises a given
  // date-parameter name — it silently ignores the ones it does not, and an
  // ignored date filter would make every variant return the same thing for a
  // reason that has nothing to do with status.
  const BASE = { property_visibility: 'active' };

  // What our sync asks for today, as the baseline to beat.
  console.log('='.repeat(76));
  console.log('baseline — what the sync sends today');
  console.log('='.repeat(76));
  const base = await call({ first_contact_date_from: FROM, first_contact_date_to: TO, property_visibility: 'active' }, 'baseline');
  if (base.error) { console.log('  ' + base.error); }
  else {
    const s = summarise(base.rows);
    console.log(`  ${s.total} rows · ${s.week} in week (strict, = what the sync sees)`);
    console.log(`  ${s.weekLoose} in week (tolerant) · ${s.unique} unique person+property`);
    if (s.unreadable) {
      console.log(`  !! ${s.unreadable} rows carry a received value new Date() CANNOT read.`);
      console.log('     The leasing sync uses the strict parser, so it is dropping these too.');
    }
    console.log(`  fields: ${Object.keys(base.rows[0] || {}).join(', ')}`);

    // RAW VALUES FIRST, before any count is trusted. The last version of this
    // probe reported a confident 0 because it was reading fields that do not
    // exist; printing what the report actually returns is what would have
    // caught that in ten seconds instead of a round trip.
    console.log('\n  raw date values, straight off the response:');
    base.rows.slice(0, 5).forEach((r, i) => {
      console.log(`    [${i}] received            = ${JSON.stringify(r.received)}   -> ${dateOnly(r.received)}`);
      console.log(`        last_activity_date  = ${JSON.stringify(r.last_activity_date)}   -> ${dateOnly(r.last_activity_date)}`);
      console.log(`        first_contact_date  = ${JSON.stringify(r.first_contact_date)}   -> ${dateOnly(r.first_contact_date)}`);
    });
    if (!base.rows.length) console.log('    (no rows came back at all — the problem is the request, not the parsing)');
    // The sanity check that makes the rest of this probe worth reading: our
    // sync gets 68 leads for this week out of this same report. If the control
    // does not land near that, the counting is still wrong and nothing below
    // means anything.
    console.log(`\n  SANITY: leasing_leads holds 68 for this week. The control reads ${s.week}.`);
    if (s.week === 0) {
      console.log('  STOP — a control of 0 against a known 68 means the date filter or the');
      console.log('  field name is still wrong. Do not read the verdicts below.');
    }
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
    const verdict = s.weekLoose === HERS ? '   <<< MATCHES HER 115'
      : (seen[0] && s.weekLoose > seen[0].weekLoose) ? '   wider than the control' : '';
    console.log(`  ${label.padEnd(26)} ${String(s.weekLoose).padStart(4)} in week · ${String(s.unique).padStart(4)} unique${verdict}`);
  }
  // A parameter AppFolio does not recognise is ignored silently, so "same
  // number as the control" means "did nothing", not "status is already all".
  const control = seen.find(s => /control/.test(s.label));
  const widened = seen.filter(s => control && s.weekLoose > control.weekLoose);
  console.log(widened.length
    ? `\n  ${widened.length} parameter(s) widened the result — the status filter is real.`
    : '\n  Nothing widened it. Either every card is already included, or none of');
  if (!widened.length) console.log('  these parameter names is recognised — AppFolio ignores unknown ones silently.');

  // ── (2) one row per interest, or per card? ────────────────────────────────
  console.log('\n' + '='.repeat(76));
  console.log('(2) one row per INTEREST, or per card?');
  console.log('='.repeat(76));
  const best = seen.slice().sort((a, b) => b.weekLoose - a.weekLoose)[0];
  if (!best) console.log('  no successful call to judge from');
  else {
    console.log(`  best result: ${best.weekLoose} rows in week, ${best.unique} unique person+property`);
    if (best.weekLoose > best.unique) {
      console.log(`  ${best.weekLoose - best.unique} rows are repeats of a person+property pair —`);
      console.log('  so the report DOES return one row per interest event.');
      console.log(best.weekLoose === HERS
        ? '  AND it matches her 115. The sync can be repointed at this.'
        : `  but it is ${best.weekLoose}, not ${HERS}. Something else still differs.`);
    } else {
      console.log('  Every row is a distinct person+property: this report returns one row');
      console.log('  per CARD, not per interest. No parameter will reproduce her 115, and');
      console.log('  the combined report needs its own per-interest table.');
    }
  }
  console.log('\nDone. Nothing was written.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
