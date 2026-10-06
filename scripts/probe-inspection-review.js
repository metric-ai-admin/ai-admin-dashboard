#!/usr/bin/env node
//
// Does AppFolio record anything at all when an inspection is REVIEWED?
//
//   node scripts/probe-inspection-review.js
//   node scripts/probe-inspection-review.js 1431 1436
//
// READ-ONLY. Nothing is written to Supabase or to AppFolio. It needs the
// AppFolio credentials, so it runs on Render Shell for the dashboard service.
//
// THE 404 ON THE FIRST VERSION WAS THIS SCRIPT'S FAULT, NOT A WRONG REPORT NAME
//
// It called appfolio-client.js's fetchReport() with a full path. That function
// takes a BARE report name and builds the URL itself:
//
//     `https://${subdomain}.appfolio.com/api/v2/reports/${report}.json`
//
// so passing '/api/v2/reports/inspection_detail.json' produced
// '.../api/v2/reports//api/v2/reports/inspection_detail.json.json', which is a
// genuine 404 about a URL nobody meant to request. "inspection_detail" is the
// right name — the daily sync pulls 628 rows with it.
//
// THE SYNC'S PATH, COPIED EXACTLY
//
// There are two AppFolio clients in this codebase and they are not
// interchangeable. The sync uses appfolioReportsFetch() in server.js, which
// differs from appfolio-client.js in all three ways that matter here:
//
//   credentials  APPFOLIO_REPORTS_CLIENT_ID / _SECRET
//                (NOT APPFOLIO_CLIENT_ID / _SECRET / _SUBDOMAIN)
//   host         hard-coded metricpropertymanagement.appfolio.com
//   filter       { property_visibility: 'active', paginate_results: false }
//
// and paginate_results:false makes AppFolio answer with a BARE ARRAY rather
// than {results:[...]}, which fetchReport() cannot unwrap — it would have
// returned zero rows even with the URL fixed. appfolioReportsFetch is not
// exported from server.js, so the request below is a minimal copy of it:
// one POST, no pagination needed, nothing written.
//
// WHY THIS CANNOT BE ANSWERED FROM SUPABASE
//
//   1. The sync keeps ELEVEN columns of inspection_detail and silently drops
//      every other column the report returns. A review field could be in the
//      response and have never once reached the database.
//   2. maintenance_inspections is replaced wholesale on every sync; synced_at
//      holds one value, today's. There is no history to diff.
//   3. The eight stored Command Center boards do give history, but only of the
//      handful of fields a card carries.
//
// WHAT THE EIGHT BOARDS ALREADY SAY
//
// Of 140 inspection cards, 2026-09-29 to 2026-10-06: none left the board, none
// changed category, marked_done_by changed for none. All 46 "review" ones are
// DONE; all 94 "pending" ones are NEW or IN PROGRESS, 69 of them created before
// 2026-09-01. "Erick Frey" appears in work orders as an assigned user and in
// none of the 628 inspections, so the rule is not failing on his name.
//
// That leaves two possibilities needing opposite responses: the re-mark is not
// happening, or it is and the report has no column that reflects it. This
// separates them.
require('dotenv').config();

const fetchFn = global.fetch;

const BASE = 'https://metricpropertymanagement.appfolio.com';
// Tried in order. inspection_detail is what the sync uses and what should
// work; unit_inspection is the name in the v1 catalogue, kept as a fallback so
// one run settles the question either way instead of needing a second.
const REPORTS = ['inspection_detail', 'unit_inspection'];
const FILTER = { property_visibility: 'active', paginate_results: false };

// The eleven the sync keeps. Everything else the report returns is dropped
// before it reaches Supabase, which is the whole reason for this probe.
const KEPT = new Set(['inspection_id', 'id', 'inspection_name', 'name',
  'inspection_template', 'template', 'property_name', 'property', 'unit_name',
  'unit', 'primary_tenant', 'primary_resident', 'resident', 'status',
  'inspection_status', 'inspection_date', 'scheduled_date', 'date',
  'marked_done_on', 'completed_on', 'done_on', 'marked_done_by',
  'completed_by', 'done_by', 'created_on', 'created_at', 'created',
  'property_id']);

async function pull(report) {
  const id = process.env.APPFOLIO_REPORTS_CLIENT_ID;
  const secret = process.env.APPFOLIO_REPORTS_CLIENT_SECRET;
  if (!id || !secret) {
    const e = new Error('APPFOLIO_REPORTS_CLIENT_ID / APPFOLIO_REPORTS_CLIENT_SECRET are not set in this shell. '
      + 'These are the Reports API credentials the sync uses, not APPFOLIO_CLIENT_ID.');
    e.code = 503;
    throw e;
  }
  const url = `${BASE}/api/v2/reports/${report}.json`;
  const resp = await fetchFn(url, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(FILTER),
  });
  if (!resp.ok) {
    const j = await resp.json().catch(() => null);
    const e = new Error((j && (j.error || j.message)) || `HTTP ${resp.status}`);
    e.code = resp.status;
    throw e;
  }
  const j = await resp.json().catch(() => null);
  // paginate_results:false answers with a bare array. The other shapes are
  // accepted too so a change at AppFolio's end does not read as "no rows".
  return { url, rows: Array.isArray(j) ? j : (j && (j.results || j.data)) || [] };
}

(async () => {
  const ids = process.argv.slice(2).filter(x => /^\d+$/.test(x));

  let got = null;
  for (const report of REPORTS) {
    try {
      const r = await pull(report);
      console.log(`${report}: ${r.rows.length} rows  (${r.url})`);
      if (!got && r.rows.length) got = { report, ...r };
    } catch (e) {
      console.log(`${report}: FAILED ${e.code || ''} ${e.message}`);
      if (e.code === 503) process.exit(2);
    }
  }
  if (!got) { console.log('\nNo report returned any rows — nothing to measure.'); process.exit(1); }
  const list = got.rows;
  console.log(`\nusing ${got.report}, ${list.length} rows`);

  console.log('\n=== EVERY COLUMN THE REPORT RETURNS ===');
  const keys = new Set();
  list.forEach(r => Object.keys(r || {}).forEach(k => keys.add(k)));
  [...keys].sort().forEach(k => {
    const vals = [...new Set(list.map(r => String(r[k] == null ? '' : r[k]).trim()).filter(Boolean))];
    console.log('  ' + (KEPT.has(k) ? '[kept]   ' : '[DROPPED]') + ' ' + k.padEnd(28)
      + String(vals.length).padStart(5) + ' distinct'
      + (vals.length && vals.length <= 6 ? '  -> ' + vals.slice(0, 6).join(' | ') : ''));
  });

  // Anything shaped like a review, an approval or a change stamp is the point
  // of the probe, so it is called out rather than left in an alphabetical list.
  console.log('\n=== CANDIDATES FOR A REVIEW SIGNAL ===');
  const cand = [...keys].filter(k => /review|approv|audit|verif|sign|updat|modif|edit|lock|submit|close|complet|done/i.test(k));
  if (!cand.length) console.log('  (none — no column here mentions review, approval or an update stamp)');
  cand.forEach(k => {
    const vals = [...new Set(list.map(r => String(r[k] == null ? '' : r[k]).trim()).filter(Boolean))];
    console.log('  ' + (KEPT.has(k) ? '[kept]   ' : '[DROPPED]') + ' ' + k + ': '
      + vals.length + ' distinct -> ' + vals.slice(0, 8).join(' | '));
  });

  // Does Erick appear ANYWHERE in the raw rows? He is in work orders as an
  // assigned user and in none of the 628 inspections as stored — if the raw
  // report has him in a column the sync drops, that column is the answer.
  console.log('\n=== DOES "ERICK" APPEAR IN ANY RAW COLUMN? ===');
  const hits = {};
  list.forEach(r => Object.entries(r || {}).forEach(([k, v]) => {
    if (/erick/i.test(String(v == null ? '' : v))) hits[k] = (hits[k] || 0) + 1;
  }));
  if (!Object.keys(hits).length) console.log('  (nowhere — in no column of any row)');
  Object.entries(hits).forEach(([k, n]) =>
    console.log('  ' + (KEPT.has(k) ? '[kept]   ' : '[DROPPED]') + ' ' + k + ': ' + n + ' rows'));

  if (!ids.length) {
    console.log('\nPass inspection ids to dump their raw rows, e.g.');
    console.log('  node scripts/probe-inspection-review.js 1431 1436');
    return;
  }
  console.log('\n=== RAW ROWS FOR THE IDS ASKED FOR ===');
  const idKey = keys.has('inspection_id') ? 'inspection_id' : 'id';
  ids.forEach(id => {
    const r = list.find(x => String(x[idKey]).trim() === id);
    console.log('\n--- ' + id + (r ? '' : '  (NOT IN THE REPORT)'));
    if (r) console.log(JSON.stringify(r, null, 1));
  });
})().catch(e => { console.error(e); process.exit(1); });
