#!/usr/bin/env node
//
// The two sheets the deficiency import does not read: Closed Cases and
// Watchlist.
//
//   node scripts/import-cv-closed-and-watchlist.js            # DRY RUN
//   node scripts/import-cv-closed-and-watchlist.js --write
//
// CLOSED CASES ARE IMPORTED AS CASES. The sheet is case-level — six real rows
// — and no deficiency is manufactured from them. A case saying it covered ten
// items does not tell us what those ten were, and inventing ten rows to make a
// count work would put fabricated citations in the tracker.
//
// Its TOTAL row and its footnote are not cases. They are recognised by the
// absence of the fields a case must have rather than by matching the word
// "Total", which would miss "TOTAL", "Grand Total", and whatever the next
// editor types.
//
// THE WATCHLIST IS MATCHED BEFORE IT IS WRITTEN. Two rows are already there,
// typed by hand, and their property spelling need not match the sheet's. A
// near-match is REPORTED for a person to decide, never merged silently.
require('dotenv').config();

const msal = require('@azure/msal-node');
const XLSX = require('xlsx');
const { createClient } = require('@supabase/supabase-js');
const CVN = require('../lib/code-violation-notes.js');
const EXCLUDED = require('../lib/excluded-properties.js');

const WRITE = process.argv.includes('--write');

const DRIVE_OWNER = process.env.CV_WORKBOOK_OWNER || 'admin@metricpropertymanagement.com';
const WORKBOOK_PATH = process.env.CV_WORKBOOK_PATH
  || 'Ops Dashboard Files/Maintenance/Code_Violations_Tracker.xlsx';

const pad = (s, w) => String(s).padEnd(w);
const clean = s => String(s == null ? '' : s).trim();

const db = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } });

async function workbook() {
  const tenant = process.env.GRAPH_TENANT_ID;
  const clientId = process.env.GRAPH_CLIENT_ID;
  const secret = process.env.GRAPH_CLIENT_SECRET;
  if (!tenant || !clientId || !secret) throw new Error('GRAPH_* are not set.');
  const app = new msal.ConfidentialClientApplication({
    auth: { clientId, authority: 'https://login.microsoftonline.com/' + tenant, clientSecret: secret },
  });
  const { accessToken } = await app.acquireTokenByClientCredential({
    scopes: ['https://graph.microsoft.com/.default'], skipCache: true,
  });
  const url = 'https://graph.microsoft.com/v1.0/users/' + encodeURIComponent(DRIVE_OWNER)
    + '/drive/root:/' + WORKBOOK_PATH.split('/').map(encodeURIComponent).join('/') + ':/content';
  const r = await global.fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } });
  if (!r.ok) throw new Error('Graph ' + r.status + ' fetching the workbook');
  return XLSX.read(Buffer.from(await r.arrayBuffer()), { type: 'buffer' });
}

function rowsOf(wb, sheet) {
  if (!wb.Sheets[sheet]) return [];
  const grid = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, defval: null, raw: false });
  const header = (grid[0] || []).map(c => clean(c));
  const out = [];
  for (let i = 1; i < grid.length; i++) {
    const cells = grid[i] || [];
    if (!cells.some(c => clean(c))) continue;
    const obj = {};
    header.forEach((col, c) => { if (col) obj[col] = cells[c]; });
    out.push({ obj, rowNumber: i + 1 });
  }
  return out;
}

(async () => {
  console.log((WRITE ? 'WRITE' : 'DRY RUN') + ' — Closed Cases and Watchlist');
  console.log('The workbook is read into memory and never written to disk.\n');
  const wb = await workbook();

  // ---- Closed Cases --------------------------------------------------------
  const closedRaw = rowsOf(wb, 'Closed Cases');
  const closed = [];
  const notCases = [];
  closedRaw.forEach(({ obj, rowNumber }) => {
    const c = CVN.closedCaseFromRow(obj, { sheet: 'Closed Cases', rowNumber });
    if (c) closed.push(c);
    else notCases.push(rowNumber);
  });

  console.log('CLOSED CASES — ' + closedRaw.length + ' non-empty row(s), '
    + closed.length + ' are cases');
  console.log('   ' + pad('property', 22) + pad('items', 7) + pad('closed', 12)
    + pad('closed by', 16) + 'case number');
  closed.forEach(c => console.log('   ' + pad(c.property, 22)
    + pad(c.items === null ? '—' : c.items, 7) + pad(c.closed_at || '—', 12)
    + pad(c.closed_by || '—', 16) + (c.case_number || 'not stated')));
  const withCase = closed.filter(c => c.case_number).length;
  console.log('\n   case number lifted from the text: ' + withCase + ' of ' + closed.length
    + '; the rest stay NULL rather than being guessed.');
  console.log('   items total: ' + closed.reduce((a, c) => a + (c.items || 0), 0));
  if (notCases.length) {
    console.log('   rows ' + notCases.join(', ') + ' are NOT cases (a total row and a '
      + 'footnote) — they carry no status, resolution, date or closer.');
  }

  // ---- Watchlist -----------------------------------------------------------
  const { data: existingWatch, error: wErr } = await db.from('code_violation_watchlist')
    .select('id,property_name,title,work_order,status');
  if (wErr) throw new Error('code_violation_watchlist: ' + wErr.message);

  const watch = [];
  const dupes = [];
  const excludedWatch = [];
  rowsOf(wb, 'Watchlist').forEach(({ obj, rowNumber }) => {
    const w = CVN.watchlistFromRow(obj, { sheet: 'Watchlist', rowNumber });
    if (!w) return;
    // The same exclusion list every view uses. The Sidney has a watchlist row
    // and Metric stopped managing it on 2026-10-07 — importing it here would
    // put it back on a screen through a side door, after a week of work
    // keeping it off the others.
    if (EXCLUDED.propertyIsExcluded(w.property_name)) {
      excludedWatch.push({ row: rowNumber, property: w.property_name });
      return;
    }
    const hit = CVN.watchlistDuplicate(w, existingWatch || []);
    if (hit) dupes.push({ row: rowNumber, title: w.title, existingId: hit.id });
    else watch.push(w);
  });

  console.log('\nWATCHLIST — ' + (existingWatch || []).length + ' already stored, '
    + (watch.length + dupes.length) + ' in the sheet');
  watch.forEach(w => console.log('   NEW  ' + pad(w.property_name, 22)
    + pad(w.work_order || '—', 12) + w.title.slice(0, 48)));
  dupes.forEach(d => console.log('   DUP  row ' + d.row + ' matches a stored row — '
    + 'NOT written. ' + d.title.slice(0, 48)));
  excludedWatch.forEach(e => console.log('   SKIP row ' + e.row + ' — ' + e.property
    + ' is on the exclusion list (Metric does not manage it)'));
  if (!dupes.length) {
    console.log('   No sheet row matched one already stored.');
  }

  if (!WRITE) {
    console.log('\nDRY RUN — nothing written.');
    return;
  }

  // ---- write ---------------------------------------------------------------
  if (closed.length) {
    const { error } = await db.from('code_violation_closed_cases')
      .upsert(closed.map(c => ({ ...c, updated_at: new Date().toISOString() })),
        { onConflict: 'source_row' });
    if (error) {
      if (/code_violation_closed_cases/.test(error.message || '')) {
        throw new Error('run supabase/migrations/105_code_violation_closed_cases.sql first');
      }
      throw new Error('closed cases: ' + error.message);
    }
  }
  if (watch.length) {
    // INSERT, not upsert: the existing two rows were typed by hand and have no
    // source_row, so there is nothing to conflict on. Duplicates were filtered
    // above, by a person-recognisable match rather than by a key.
    const { error } = await db.from('code_violation_watchlist')
      .insert(watch.map(({ source_row, ...w }) => w));
    if (error) throw new Error('watchlist: ' + error.message);
  }
  console.log('\nstored: ' + closed.length + ' closed case(s), ' + watch.length
    + ' watchlist row(s). ' + dupes.length + ' skipped as already present.');
  console.log('No deficiency was manufactured from a closed case.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
