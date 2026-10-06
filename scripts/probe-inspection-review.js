#!/usr/bin/env node
//
// Does AppFolio record anything at all when an inspection is REVIEWED?
//
//   node scripts/probe-inspection-review.js
//
// READ-ONLY. Nothing is written to Supabase or to AppFolio. Needs the AppFolio
// credentials, so it runs on Render Shell for the dashboard service.
//
// WHY THIS CANNOT BE ANSWERED FROM SUPABASE
//
// Three separate reasons, and all three had to be checked before concluding
// anything:
//
//   1. The sync keeps ELEVEN columns of inspection_detail — inspection_id,
//      name, property, unit, resident, status, inspection_date, marked_done_on,
//      marked_done_by, created_on, property_id — and silently drops every other
//      column the report returns. A review field could be sitting in the
//      response and have never once reached the database.
//
//   2. maintenance_inspections is replaced wholesale on every sync. synced_at
//      holds one value, today's. There is no history to diff.
//
//   3. The Command Center's own stored boards DO give eight days of history,
//      but only of the handful of fields a card carries.
//
// WHAT THE EIGHT BOARDS ALREADY SAY
//
// Of 140 inspection cards, across 2026-09-29 to 2026-10-06: none left the
// board, none changed category, and marked_done_by changed for none of them.
// All 46 "review" ones are DONE; all 94 "pending" ones are NEW or IN PROGRESS.
// "Erick Frey" appears in work orders as an assigned user but in NONE of the
// 628 inspections, so this is not the rule matching his name wrongly.
//
// That leaves exactly two possibilities, which need opposite responses:
//
//   (a) the re-mark is not happening, and 46 inspections are genuinely
//       outstanding — a process question, not a software one;
//   (b) it is happening and inspection_detail has no column that reflects it,
//       in which case NO report-based rule can ever work and the card has to
//       stay manual or be driven from somewhere else entirely.
//
// This separates them. It prints every raw key the report returns, so a review
// or approval column that the sync discards becomes visible, and then dumps
// every raw field for the 46 inspections in question.
require('dotenv').config();

const { fetchReport, isConfigured } = require('../appfolio-client.js');

if (!isConfigured()) {
  console.error('AppFolio is not configured in this shell.');
  console.error('Run this on Render Shell for the dashboard service.');
  process.exit(2);
}

// The 46 as of 2026-10-06. Hard-coded rather than read back from Supabase so
// this script answers the same question wherever it runs.
const REVIEW_IDS = process.argv.slice(2).filter(x => /^\d+$/.test(x));

(async () => {
  const rows = await fetchReport('/api/v2/reports/inspection_detail.json',
    { property_visibility: 'active' });
  const list = Array.isArray(rows) ? rows : (rows && rows.results) || [];
  console.log('rows returned:', list.length);
  if (!list.length) { console.log('nothing to inspect'); return; }

  // Every key the report actually returns, against the eleven the sync keeps.
  const KEPT = new Set(['inspection_id', 'id', 'inspection_name', 'name',
    'inspection_template', 'template', 'property_name', 'property', 'unit_name',
    'unit', 'primary_tenant', 'primary_resident', 'resident', 'status',
    'inspection_status', 'inspection_date', 'scheduled_date', 'date',
    'marked_done_on', 'completed_on', 'done_on', 'marked_done_by',
    'completed_by', 'done_by', 'created_on', 'created_at', 'created',
    'property_id']);
  const keys = new Set();
  list.forEach(r => Object.keys(r || {}).forEach(k => keys.add(k)));
  console.log('\n=== EVERY COLUMN THE REPORT RETURNS ===');
  [...keys].sort().forEach(k => {
    const nonEmpty = list.filter(r => r[k] !== null && r[k] !== undefined && String(r[k]).trim() !== '').length;
    const vals = [...new Set(list.map(r => String(r[k] == null ? '' : r[k]).trim()).filter(Boolean))];
    console.log('  ' + (KEPT.has(k) ? '[kept]   ' : '[DROPPED]') + ' ' + k.padEnd(28)
      + String(nonEmpty).padStart(5) + ' filled, ' + String(vals.length).padStart(4) + ' distinct'
      + (vals.length && vals.length <= 6 ? '  -> ' + vals.slice(0, 6).join(' | ') : ''));
  });

  // Anything that smells like a review, an approval or a change stamp is the
  // whole point of this probe, so it is called out rather than left in the list.
  console.log('\n=== CANDIDATES FOR A REVIEW SIGNAL ===');
  const cand = [...keys].filter(k => /review|approv|audit|verif|sign|updat|modif|edit|lock|submit|close/i.test(k));
  if (!cand.length) console.log('  (none — no column in this report mentions review, approval or an update stamp)');
  cand.forEach(k => {
    const vals = [...new Set(list.map(r => String(r[k] == null ? '' : r[k]).trim()).filter(Boolean))];
    console.log('  ' + k + ': ' + vals.length + ' distinct -> ' + vals.slice(0, 8).join(' | '));
  });

  if (!REVIEW_IDS.length) {
    console.log('\nPass inspection ids as arguments to dump their raw rows, e.g.');
    console.log('  node scripts/probe-inspection-review.js 1431 1436');
    return;
  }
  console.log('\n=== RAW ROWS FOR THE IDS ASKED FOR ===');
  const idKey = keys.has('inspection_id') ? 'inspection_id' : 'id';
  REVIEW_IDS.forEach(id => {
    const r = list.find(x => String(x[idKey]).trim() === id);
    console.log('\n--- ' + id + (r ? '' : '  (NOT IN THE REPORT)'));
    if (r) console.log(JSON.stringify(r, null, 1));
  });
})().catch(e => { console.error(e); process.exit(1); });
