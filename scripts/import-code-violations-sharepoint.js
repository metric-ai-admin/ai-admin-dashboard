#!/usr/bin/env node
//
// Import the Code Violations tracker from SharePoint, by Graph.
//
//   node scripts/import-code-violations-sharepoint.js            # DRY RUN
//   node scripts/import-code-violations-sharepoint.js --write
//
// The workbook is read into MEMORY and never written to disk: it carries
// addresses, unit numbers and the names of city officers, and `exports/` is
// gitignored for exactly that reason.
//
// WHAT THIS DOES NOT DO:
//
//   * It does not import The Sidney. Metric stopped managing it on
//     2026-10-07; its sheet is still in the workbook and is listed separately
//     rather than silently dropped, because a property that vanishes from a
//     report looks the same as one with nothing wrong.
//   * It does not invent the four Hyde Park Square deficiencies. The Summary
//     sheet counts them in its Grand Total of 78 and there is no Hyde Park
//     sheet to take them from. They are reported MISSING. A count that only
//     adds up because somebody fabricated the rows is worse than one that
//     does not add up and says so.
//   * It does not read an author out of a note. See lib/code-violation-notes.js.
//
// READ BEFORE WRITE, like the existing /api/code-violations/import: a blind
// upsert cannot tell a row somebody is holding from one nobody has touched,
// and re-running a workbook once replaced every hand-set status with the
// spreadsheet's.
require('dotenv').config();

const msal = require('@azure/msal-node');
const XLSX = require('xlsx');
const { createClient } = require('@supabase/supabase-js');
const CV = require('../code-violations.js');
const CVN = require('../lib/code-violation-notes.js');
const EXCLUDED = require('../lib/excluded-properties.js');

const WRITE = process.argv.includes('--write');

// The workbook Jay's dashboard reads. admin@'s OneDrive.
const DRIVE_OWNER = process.env.CV_WORKBOOK_OWNER || 'admin@metricpropertymanagement.com';
const WORKBOOK_PATH = process.env.CV_WORKBOOK_PATH
  || 'Ops Dashboard Files/Maintenance/Code_Violations_Tracker.xlsx';

// Not data sheets. Dashboard is a COUNTIFS block, Summary is the per-property
// roll-up whose Grand Total this import is checked against.
const NON_DATA_SHEETS = new Set(['Dashboard', 'Summary']);

const pad = (s, w) => String(s).padEnd(w);
const clean = s => String(s == null ? '' : s).trim();

const db = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } });

async function graphToken() {
  const tenant = process.env.GRAPH_TENANT_ID;
  const clientId = process.env.GRAPH_CLIENT_ID;
  const secret = process.env.GRAPH_CLIENT_SECRET;
  if (!tenant || !clientId || !secret) {
    throw new Error('GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET are not set. Run on Render.');
  }
  const app = new msal.ConfidentialClientApplication({
    auth: { clientId, authority: 'https://login.microsoftonline.com/' + tenant, clientSecret: secret },
  });
  // skipCache for the same reason graphMailToken does it: a token minted
  // before a permission was added keeps being served with the old roles.
  const r = await app.acquireTokenByClientCredential({
    scopes: ['https://graph.microsoft.com/.default'], skipCache: true,
  });
  return r.accessToken;
}

async function downloadWorkbook(token) {
  const url = 'https://graph.microsoft.com/v1.0/users/' + encodeURIComponent(DRIVE_OWNER)
    + '/drive/root:/' + WORKBOOK_PATH.split('/').map(encodeURIComponent).join('/') + ':/content';
  const r = await global.fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) {
    throw new Error('Graph ' + r.status + ' fetching the workbook — check the path and Files.Read.All');
  }
  return Buffer.from(await r.arrayBuffer());
}

// The header row is the first one carrying "Case Number". Taking row 0 on
// faith is how a title line becomes the column names — the same trap the
// Katie workbooks had.
function headerAt(rows) {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const r = (rows[i] || []).map(c => clean(c));
    if (r.includes('Case Number') && r.includes('Property Name')) return i;
  }
  return -1;
}

function sheetRows(wb, name) {
  const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null, raw: false });
  const h = headerAt(grid);
  if (h < 0) return { header: null, rows: [] };
  const header = grid[h].map(c => clean(c));
  const rows = [];
  for (let i = h + 1; i < grid.length; i++) {
    const cells = grid[i] || [];
    const obj = {};
    header.forEach((col, c) => { if (col) obj[col] = cells[c]; });
    // A row is real if it names a property AND carries a case or a
    // description. A blank spacer row has neither.
    if (clean(obj['Property Name']) && (clean(obj['Case Number']) || clean(obj['Deficiency Description']))) {
      rows.push({ obj, rowNumber: i + 1 });
    }
  }
  return { header, rows };
}

// The workbook's column names -> what normaliseImportRow expects.
const toImportRow = o => ({
  property_name: o['Property Name'],
  case_number: o['Case Number'],
  work_order: o['Work Order'],
  address_unit: o['Address/Unit'],
  deficiency_date: o['Deficiency Date'],
  deficiency_description: o['Deficiency Description'],
  category: o['Category'],
  status: o['Status'],
  due_date: o['Due Date'],
  notice_date: o['Notice Date'],
  pending_items: o['Pending Items'],
  completed_items: o['Completed Items'],
  maintenance_remarks: o['Maintenance Remarks'],
  client_vendor_remarks: o['Client/Vendor Remarks'],
  progress_notes: o['Progress Notes'],
});

// The Summary sheet's per-property totals, so the import can be checked
// against the figure the people who keep this workbook read.
function summaryTotals(wb) {
  if (!wb.Sheets.Summary) return null;
  const grid = XLSX.utils.sheet_to_json(wb.Sheets.Summary, { header: 1, defval: null, raw: false });
  const h = grid.findIndex(r => (r || []).some(c => clean(c) === 'Property'));
  if (h < 0) return null;
  const header = grid[h].map(c => clean(c));
  const totalCol = header.indexOf('TOTAL');
  if (totalCol < 0) return null;
  const out = {};
  for (let i = h + 1; i < grid.length; i++) {
    const name = clean((grid[i] || [])[0]);
    if (!name) continue;
    const n = Number(clean((grid[i] || [])[totalCol]));
    if (!Number.isFinite(n)) continue;
    out[name] = n;
  }
  return out;
}

(async () => {
  console.log((WRITE ? 'WRITE' : 'DRY RUN') + ' — ' + WORKBOOK_PATH);
  console.log('The workbook is read into memory and never written to disk.\n');

  const wb = XLSX.read(await downloadWorkbook(await graphToken()), { type: 'buffer' });
  const summary = summaryTotals(wb);

  const deficiencies = [];
  const notes = [];
  const rejected = [];
  const skippedSidney = [];
  const skippedEmptyNotes = { count: 0 };
  const perSheet = {};

  wb.SheetNames.filter(n => !NON_DATA_SHEETS.has(n)).forEach(sheet => {
    const { header, rows } = sheetRows(wb, sheet);
    perSheet[sheet] = { found: rows.length, imported: 0, header: !!header };
    if (!header) return;

    rows.forEach(({ obj, rowNumber }) => {
      const property = clean(obj['Property Name']);
      // Excluded properties are NOT imported, and ARE listed. The Sidney is
      // the live case; the rule is the shared fragment list, not a name typed
      // here, so Brazos or Lily Pad would be caught the same way.
      if (EXCLUDED.propertyIsExcluded(property)) {
        skippedSidney.push({ sheet, rowNumber, property, case: clean(obj['Case Number']) });
        return;
      }
      const r = CV.normaliseImportRow(toImportRow(obj), { source: 'excel' });
      if (!r.ok) {
        rejected.push({ sheet, rowNumber, property, case: clean(obj['Case Number']), error: r.error });
        return;
      }
      // Kept for the by-sheet report only; stripped before the write.
      deficiencies.push(Object.assign(r.row, { __sheet: sheet }));
      perSheet[sheet].imported += 1;

      const made = CVN.notesFromExcelRow(obj, { sheet, rowNumber, deficiencyKey: r.row.deficiency_key });
      notes.push(...made);
      // Every note block that existed but said nothing.
      CVN.EXCEL_NOTE_COLUMNS.forEach(([col]) => {
        const v = clean(obj[col]);
        if (v && CVN.isEmptyNote(v)) skippedEmptyNotes.count += 1;
      });
    });
  });

  // ---- what is already stored ----------------------------------------------
  const keys = deficiencies.map(d => d.deficiency_key);
  const stored = {};
  for (let i = 0; i < keys.length; i += 200) {
    const { data, error } = await db.from('code_violations')
      .select('deficiency_key,property_name,status').in('deficiency_key', keys.slice(i, i + 200));
    if (error) throw new Error(error.message);
    (data || []).forEach(r => { stored[r.deficiency_key] = r; });
  }
  const { count: storedTotal } = await db.from('code_violations')
    .select('*', { count: 'exact', head: true });

  const existing = deficiencies.filter(d => stored[d.deficiency_key]);
  const fresh = deficiencies.filter(d => !stored[d.deficiency_key]);

  // ---- the report -----------------------------------------------------------
  console.log('DEFICIENCIES BY PROPERTY');
  const byProp = {};
  deficiencies.forEach(d => {
    const p = d.property_name;
    byProp[p] = byProp[p] || { total: 0, update: 0, new: 0 };
    byProp[p].total += 1;
    if (stored[d.deficiency_key]) byProp[p].update += 1; else byProp[p].new += 1;
  });
  console.log('   ' + pad('property', 26) + pad('import', 8) + pad('update', 8) + pad('new', 7) + 'Summary says');
  Object.keys(byProp).sort().forEach(p => {
    const b = byProp[p];
    const says = summary && summary[p] !== undefined ? String(summary[p]) : '—';
    const flag = (summary && summary[p] !== undefined && summary[p] !== b.total) ? '   <-- DIFFERS' : '';
    console.log('   ' + pad(p, 26) + pad(b.total, 8) + pad(b.update, 8) + pad(b.new, 7) + pad(says, 6) + flag);
  });
  console.log('   ' + pad('TOTAL', 26) + pad(deficiencies.length, 8)
    + pad(existing.length, 8) + pad(fresh.length, 7));
  console.log('\n   code_violations already holds ' + (storedTotal || 0) + ' row(s); '
    + existing.length + ' of them are in this workbook and would be updated.');
  console.log('   ' + (storedTotal || 0 - existing.length >= 0
    ? ((storedTotal || 0) - existing.length) + ' stored row(s) are NOT in this workbook — '
      + 'left exactly as they are, never deleted.' : ''));

  // ---- notes ---------------------------------------------------------------
  // WHICH SHEET EACH ROW CAME FROM. A property's rows do not always live on a
  // sheet of its own — Hyde Park Square's four sit on another property's
  // sheet — and a reader comparing against the workbook needs to know where
  // to look. Reading the sheet list and assuming one sheet per property is
  // what produced a wrong "no detail sheet" claim on 2026-10-19.
  console.log('\nBY SHEET');
  Object.entries(perSheet).forEach(([sheet, s]) =>
    console.log('   ' + pad(sheet, 26) + pad(s.found + ' row(s) found', 20)
      + s.imported + ' imported' + (s.header ? '' : '   (no header row — nothing read)')));
  const crossSheet = {};
  deficiencies.forEach(d => {
    const k = d.__sheet + ' -> ' + d.property_name;
    if (d.__sheet && d.__sheet !== d.property_name) crossSheet[k] = (crossSheet[k] || 0) + 1;
  });
  if (Object.keys(crossSheet).length) {
    console.log('\n   ROWS ON ANOTHER PROPERTY\'S SHEET:');
    Object.entries(crossSheet).forEach(([k, n]) => console.log('      ' + k + '   ' + n + ' row(s)'));
  }

  console.log('\nNOTES');
  const notesByProp = {};
  notes.forEach(n => {
    const d = deficiencies.find(x => x.deficiency_key === n.deficiency_key);
    const p = d ? d.property_name : '(unattached)';
    notesByProp[p] = (notesByProp[p] || 0) + 1;
  });
  Object.keys(notesByProp).sort().forEach(p =>
    console.log('   ' + pad(p, 26) + notesByProp[p]));
  console.log('   ' + pad('TOTAL', 26) + notes.length);
  const withDate = notes.filter(n => n.authored_at).length;
  console.log('\n   author:      0 of ' + notes.length
    + ' — the workbook has no author column, and a name is never read out of the text');
  console.log('   authored_at: ' + withDate + ' of ' + notes.length
    + ' — the rest stay null rather than taking the import date');

  // ---- what was left out ----------------------------------------------------
  console.log('\nNOT IMPORTED');
  console.log('   ' + skippedEmptyNotes.count + ' note cell(s) held only a placeholder '
    + '("None yet.", "-", "TBD") — not imported, because a placeholder under a '
    + 'timestamp reads as somebody having checked.');

  if (skippedSidney.length) {
    console.log('\n   EXCLUDED PROPERTIES — listed, not imported:');
    const bySid = {};
    skippedSidney.forEach(s => { bySid[s.property] = (bySid[s.property] || 0) + 1; });
    Object.entries(bySid).forEach(([p, n]) =>
      console.log('      ' + pad(p, 24) + n + ' row(s)   (Metric no longer manages it)'));
  } else {
    console.log('\n   No excluded property had any row in the workbook.');
  }

  if (rejected.length) {
    console.log('\n   REJECTED — a citation that fails to import is the one thing');
    console.log('   this must not lose quietly:');
    rejected.forEach(r => console.log('      ' + pad(r.sheet + ' row ' + r.rowNumber, 28) + r.error));
  }

  // ---- the Summary's own arithmetic ----------------------------------------
  if (summary) {
    console.log('\nAGAINST THE SUMMARY SHEET');
    const grand = summary['GRAND TOTAL'];
    const sheetNames = new Set(wb.SheetNames);
    const missing = Object.entries(summary)
      .filter(([p, n]) => p !== 'GRAND TOTAL' && n > 0 && !sheetNames.has(p)
        && !EXCLUDED.propertyIsExcluded(p));
    if (grand !== undefined) {
      const accounted = deficiencies.length + skippedSidney.length
        + missing.reduce((a, [, n]) => a + n, 0);
      console.log('   Grand Total says ' + grand + '; this run accounts for ' + accounted
        + (accounted === grand ? '  — reconciled' : '  <-- DOES NOT RECONCILE'));
    }
    if (missing.length) {
      console.log('\n   COUNTED IN THE SUMMARY WITH NO DETAIL SHEET TO IMPORT FROM:');
      missing.forEach(([p, n]) => console.log('      ' + pad(p, 24) + n + ' deficienc'
        + (n === 1 ? 'y' : 'ies') + ' — MISSING, not invented'));
      console.log('      These are real citations somebody is tracking. The workbook');
      console.log('      has no rows for them; ask whoever keeps it for the detail.');
    }
  }

  // SHEETS THIS IMPORT DOES NOT READ. "Closed Cases" and "Watchlist" are
  // real content in somebody's workbook; they have no header row this
  // recognises, so nothing is taken from them. Said out loud, because a sheet
  // silently ignored is indistinguishable from a sheet that was empty.
  const unread = Object.entries(perSheet).filter(([, s]) => !s.header).map(([n]) => n);
  if (unread.length) {
    console.log('\n   SHEETS NOT READ (no recognisable header row): ' + unread.join(', '));
    console.log('   Nothing is taken from them. If any holds citations, say so and');
    console.log('   they get their own mapping rather than being forced into this one.');
  }

  if (!WRITE) {
    console.log('\nDRY RUN — nothing written. Re-run with --write.');
    return;
  }

  // ---- the write ------------------------------------------------------------
  const now = new Date().toISOString();
  const payload = deficiencies.map(({ __sheet, ...d }) => ({
    ...d, imported_at: now, updated_at: now, updated_by: 'sharepoint import',
  }));
  for (let i = 0; i < payload.length; i += 200) {
    const { error } = await db.from('code_violations')
      .upsert(payload.slice(i, i + 200), { onConflict: 'deficiency_key' });
    if (error) throw new Error('code_violations: ' + error.message);
  }
  for (let i = 0; i < notes.length; i += 200) {
    const { error } = await db.from('code_violation_notes')
      .upsert(notes.slice(i, i + 200), { onConflict: 'source_row' });
    if (error) throw new Error('code_violation_notes: ' + error.message);
  }
  console.log('\nstored: ' + payload.length + ' deficiencies, ' + notes.length + ' notes.');
  console.log('Nothing was deleted. Rows not in this workbook keep their values.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
