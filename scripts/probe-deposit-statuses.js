#!/usr/bin/env node
//
// Does security_deposit_funds_detail keep a resident after they move out?
// READ ONLY — one report read per status set. Nothing is written anywhere.
//
//   node scripts/probe-deposit-statuses.js
//
// THE QUESTION. The first snapshot returned 215 rows: 210 Current, 5 Notice,
// and NOT ONE with a move-out date in the past. If the report drops a resident
// the moment the tenancy ends, "the row stopped coming back" means "they moved
// out" and not "the deposit was settled" — and the FAS alert built on that can
// never fire, while showing zeros that read as perfect compliance.
//
// WHY THAT IS NOT YET PROVEN, and why this file exists rather than a redesign:
// the sync asks with `{ property_visibility: 'active' }` and NO tenant_statuses
// filter. This API answers a filter it does not honour without ever erring, and
// a status nobody asks for comes back as zero rows — indistinguishable from a
// status the account does not have. That exact mistake sat in the repo for
// weeks about work-order statuses ("Work Done" and "Ready to Bill" reported
// ABSENT; both existed, neither was ever requested). A filtered pull cannot be
// used as evidence about what it excludes.
//
// So this asks for everything and compares.
//
// NOTHING PERSONAL IS PRINTED: counts by status, counts of past-dated
// move-outs, and column names. No name, unit, amount or occupancy id.
require('dotenv').config();

const ID = process.env.APPFOLIO_REPORTS_CLIENT_ID;
const SECRET = process.env.APPFOLIO_REPORTS_CLIENT_SECRET;
const HOST = process.env.APPFOLIO_REPORTS_HOST || 'metricpropertymanagement.appfolio.com';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = (s, w) => String(s).padEnd(w);
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

async function call(body) {
  const r = await global.fetch(
    'https://' + HOST + '/api/v2/reports/security_deposit_funds_detail.json', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(ID + ':' + SECRET).toString('base64'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: r.status, json, text };
}

const rowsOf = j => (Array.isArray(j) ? j : ((j && (j.results || j.data)) || []));

// Counts only — this report carries residents, units and amounts.
function summarise(rows) {
  const byStatus = {};
  let pastMoveOut = 0, futureMoveOut = 0, noMoveOut = 0;
  rows.forEach(r => {
    const s = String(r.tenant_status == null ? '' : r.tenant_status).trim() || '(blank)';
    byStatus[s] = (byStatus[s] || 0) + 1;
    const mo = String(r.move_out == null ? '' : r.move_out).slice(0, 10);
    if (!mo) noMoveOut++;
    else if (mo < today) pastMoveOut++;
    else futureMoveOut++;
  });
  return { n: rows.length, byStatus, pastMoveOut, futureMoveOut, noMoveOut };
}

const show = (label, s) => {
  console.log('   ' + pad(label, 34) + pad(s.n + ' rows', 12)
    + 'past move-out: ' + s.pastMoveOut
    + '   future: ' + s.futureMoveOut + '   none: ' + s.noMoveOut);
  console.log('      by tenant_status: '
    + Object.keys(s.byStatus).sort().map(k => k + ' ' + s.byStatus[k]).join(' · '));
};

(async () => {
  if (!ID || !SECRET) {
    console.error('APPFOLIO_REPORTS_CLIENT_ID / _SECRET are not set in this shell. Run on Render.');
    process.exitCode = 1;
    return;
  }

  console.log('SECURITY DEPOSIT FUNDS DETAIL — does a mover-out stay on it?');
  console.log('today (Central): ' + today + '\n');

  // 1. THE BASELINE: exactly what the sync asks for today.
  console.log('1. WHAT THE SYNC ASKS FOR NOW');
  const base = await call({ property_visibility: 'active', paginate_results: false });
  if (base.status >= 400) {
    console.log('   REJECTED ' + base.status + ' — ' + base.text.slice(0, 200));
    return;
  }
  const baseRows = rowsOf(base.json);
  show('property_visibility: active', summarise(baseRows));
  console.log('      columns: ' + (baseRows.length ? Object.keys(baseRows[0]).join(', ') : '(none)'));
  await sleep(1200);

  // 2. EVERY STATUS CODE. AppFolio's tenant_statuses are small integers; 0..12
  //    covers the range the other reports in this repo use (delinquency asks
  //    for 0, 3 and 4). Asking for all of them is the only way to learn which
  //    exist — one that is never requested returns nothing and looks absent.
  console.log('\n2. ASKING FOR EVERY tenant_statuses CODE 0..12');
  const allCodes = Array.from({ length: 13 }, (_, i) => String(i));
  const all = await call({
    property_visibility: 'active', tenant_statuses: allCodes, paginate_results: false,
  });
  if (all.status >= 400) {
    console.log('   REJECTED ' + all.status + ' — ' + all.text.slice(0, 200));
    console.log('   (a rejection here means the parameter is not accepted at all,');
    console.log('    which is itself the answer: the filter is not why past');
    console.log('    residents are missing.)');
  } else {
    const allRows = rowsOf(all.json);
    show('tenant_statuses 0..12', summarise(allRows));
    console.log('\n   AGAINST THE BASELINE: ' + baseRows.length + ' -> ' + allRows.length
      + ' rows (' + (allRows.length - baseRows.length >= 0 ? '+' : '')
      + (allRows.length - baseRows.length) + ')');
  }
  await sleep(1200);

  // 3. ONE CODE AT A TIME, so a status that exists but is empty can be told
  //    from one the report does not know. A count of zero for a code the API
  //    accepted is a real answer; a rejection is a different one.
  console.log('\n3. ONE CODE AT A TIME');
  for (const code of allCodes) {
    const r = await call({
      property_visibility: 'active', tenant_statuses: [code], paginate_results: false,
    });
    const rows = rowsOf(r.json);
    if (r.status >= 400) {
      console.log('   code ' + pad(code, 4) + 'REJECTED ' + r.status);
    } else {
      const s = summarise(rows);
      console.log('   code ' + pad(code, 4) + pad(s.n + ' rows', 12)
        + 'past move-out: ' + s.pastMoveOut
        + '   statuses: ' + (Object.keys(s.byStatus).sort().join(', ') || '—'));
    }
    // 2.3s, not 0.9s. The rate limiter in appfolio-client.js is PER PROCESS:
    // this script shares no counter with the dashboard's crons, and the 7-per-
    // 15s budget belongs to the AppFolio ACCOUNT. At 900ms this probe alone
    // asks for ~16 per 15s, so it only ever fit in a gap between syncs. At
    // 2300ms it asks for ~6.5 per 15s and is safe to run in any gap.
    await sleep(2300);
  }

  console.log('\nWHAT THE ANSWER MEANS');
  console.log('  PAST MOVE-OUTS APPEAR  -> the report does keep them and the current');
  console.log('     design works: the sync is missing a tenant_statuses parameter,');
  console.log('     and adding it is the whole fix.');
  console.log('  THEY DO NOT APPEAR     -> "gone from the list" means "moved out", not');
  console.log('     "settled". The FAS alert cannot be built on this report and the');
  console.log('     sync must stop before it reports zeros that look like compliance.');
  console.log('\nNothing was written. No name, unit, amount or occupancy id was printed.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
