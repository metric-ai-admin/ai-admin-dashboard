#!/usr/bin/env node
//
// READ ONLY probe. Run on Render Shell, where the AppFolio credentials live.
//
//   node scripts/probe-appfolio-catalogue.js
//
// It only reads. Nothing is written to AppFolio, to Supabase or to disk, and no
// saved report is created, changed or deleted.
//
// TWO QUESTIONS:
//
// (a) IS THERE A CATALOGUE? box_score, move_out and move_ins_move_outs all
//     answer "Id is not a valid report", and appfolio-reports.js has no alias
//     for a box score. Before concluding it is unreachable, ask the API what
//     report names it will accept. If a catalogue endpoint exists, this prints
//     every name; if it does not, it says so and tries a short list of plausible
//     spellings instead.
//
// (b) WHAT DOES rental_applications CALL ITS TWO STATUS COLUMNS? Lyndsay's
//     workbook shows the report returns both: a column headed "Status" holding
//     Converted / Converting / Approved / Denied / Canceled / Decision Pending /
//     In Screening, and one headed "Application Status" holding the rolled-up
//     Approved / Denied / Canceled / Decision Pending / In Screening.
//
//     Vacant Rented on her report is apps whose status is "Converting", and
//     that value lives ONLY in the first column. Our sync maps
//     r.application_status — the SECOND one — so "Converting" never reaches
//     leasing_applications and Vacant Rented cannot be computed. This prints
//     the raw field names and their distinct values so the right one can be
//     mapped by name rather than by guess.

require('dotenv').config();

const ID = process.env.APPFOLIO_REPORTS_CLIENT_ID;
const SECRET = process.env.APPFOLIO_REPORTS_CLIENT_SECRET;
const HOST = process.env.APPFOLIO_REPORTS_HOST || 'metricpropertymanagement.appfolio.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const auth = () => 'Basic ' + Buffer.from(`${ID}:${SECRET}`).toString('base64');

async function call(path, method, body) {
  const r = await fetch(`https://${HOST}${path}`, {
    method,
    headers: Object.assign({ Authorization: auth() },
      method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
    body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
  });
  const txt = await r.text();
  if (!r.ok) return { status: r.status, error: txt.slice(0, 180).replace(/\s+/g, ' ') };
  try { return { status: r.status, json: JSON.parse(txt) }; }
  catch { return { status: r.status, error: 'not JSON' }; }
}

(async () => {
  if (!ID || !SECRET) {
    console.error('APPFOLIO_REPORTS_CLIENT_ID / _SECRET are not set here.');
    console.error('Run this on Render Shell, not a laptop.');
    process.exit(1);
  }
  console.log('READ ONLY. Nothing is written anywhere.\n');

  // ── (a) the catalogue ─────────────────────────────────────────────────────
  console.log('='.repeat(76));
  console.log('(a) is there a report catalogue?');
  console.log('='.repeat(76));
  for (const [path, method] of [
    ['/api/v2/reports.json', 'GET'],
    ['/api/v2/reports', 'GET'],
    ['/api/v1/reports.json', 'GET'],
    ['/api/v2/reports/index.json', 'GET'],
  ]) {
    const r = await call(path, method);
    if (r.error) { console.log(`  ${method} ${path.padEnd(32)} ${r.status} ${r.error.slice(0, 70)}`); }
    else {
      const j = r.json;
      const list = Array.isArray(j) ? j : (j.reports || j.results || j.data || []);
      console.log(`  ${method} ${path.padEnd(32)} ${r.status} — ${list.length} entries`);
      list.slice(0, 80).forEach(x => console.log(`      ${typeof x === 'string' ? x : JSON.stringify(x).slice(0, 110)}`));
      if (list.length) { console.log('\n  ^ this is the list of valid report names.'); }
    }
    await sleep(500);
  }

  console.log('\n  If every line above is an error, there is no catalogue endpoint');
  console.log('  and the spellings below are the only other way to look.');
  const SPELLINGS = ['box_score', 'boxscore', 'box_score_detail', 'leasing_box_score',
    'property_box_score', 'move_in_move_out', 'move_in_out', 'moveins_moveouts',
    'occupancy_box_score', 'leasing_activity', 'resident_activity'];
  for (const name of SPELLINGS) {
    const r = await call(`/api/v2/reports/${name}.json`, 'POST',
      { property_visibility: 'active', paginate_results: true });
    const valid = !r.error;
    console.log(`  ${name.padEnd(26)} ${valid ? 'VALID — ' + ((r.json?.results || r.json || []).length) + ' rows' : r.status + ' ' + String(r.error).slice(0, 56)}`);
    await sleep(500);
  }

  // ── (b) the two status columns ────────────────────────────────────────────
  console.log('\n' + '='.repeat(76));
  console.log('(b) rental_applications — which field carries "Converting"?');
  console.log('='.repeat(76));
  const ra = await call('/api/v2/reports/rental_applications.json', 'POST',
    { property_visibility: 'active', paginate_results: true });
  if (ra.error) { console.log('  ' + ra.status + ' ' + ra.error); }
  else {
    const rows = ra.json?.results || ra.json?.data || (Array.isArray(ra.json) ? ra.json : []);
    console.log(`  ${rows.length} rows`);
    const fields = Object.keys(rows[0] || {});
    console.log(`  fields: ${fields.join(', ')}\n`);
    // Every field whose values look like an application state. The one holding
    // "Converting" is the one to map.
    fields.filter(f => /status|state|stage/i.test(f)).forEach(f => {
      const vals = {};
      rows.forEach(r2 => { const v = String(r2[f] ?? '').trim(); if (v) vals[v] = (vals[v] || 0) + 1; });
      const hasConverting = Object.keys(vals).some(v => /converting/i.test(v));
      console.log(`  ${f}${hasConverting ? '   <-- HAS "Converting", map THIS one' : ''}`);
      Object.entries(vals).sort((a, b) => b[1] - a[1]).slice(0, 10)
        .forEach(([v, n]) => console.log(`      ${v} = ${n}`));
      console.log('');
    });
    const none = !fields.some(f => rows.some(r2 => /converting/i.test(String(r2[f] ?? ''))));
    if (none) console.log('  No field holds "Converting" — the API returns less than the saved report does.');
  }
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
