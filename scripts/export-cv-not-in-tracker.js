#!/usr/bin/env node
//
// The deficiencies the current SharePoint tracker does not contain, as a
// workbook for Erick to review.
//
//   node scripts/export-cv-not-in-tracker.js
//   node scripts/export-cv-not-in-tracker.js --out "C:/path/review.xlsx"
//
// Read-only against the database. Writes one .xlsx and nothing else.
//
// WHAT THE SHEET HAS TO ANSWER, because that is the question in the room: for
// each of these rows, is there something in the current tracker that is
// plainly the same thing? So every row carries whether its case number and
// work order appear on an imported row, and the description of that row
// alongside its own — a person comparing two descriptions settles in seconds
// what no rule here could.
//
// IT DOES NOT CALL ANYTHING A DUPLICATE. 39 of the 51 share a case number and
// a work order with something imported, and not one shares the opening
// description: either the same deficiency reworded, or a different deficiency
// under the same case, which one work order routinely covers. The column is
// headed "Same case + WO as a current row?" and the verdict column is left
// EMPTY for Erick to fill.
require('dotenv').config();

const path = require('path');
const XLSX = require('xlsx');
const { createClient } = require('@supabase/supabase-js');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const OUT = arg('out', path.join(process.cwd(), 'exports',
  'code-violations-not-in-tracker-' + new Date().toISOString().slice(0, 10) + '.xlsx'));

const clean = s => String(s == null ? '' : s).trim();

const db = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } });

(async () => {
  const { data, error } = await db.from('code_violations')
    .select('deficiency_key,property_name,case_number,work_order,address_unit,'
      + 'deficiency_description,status,deficiency_date,in_current_tracker,updated_by')
    .limit(5000);
  if (error) throw new Error(error.message);

  const absent = (data || []).filter(r => r.in_current_tracker === false);
  const current = (data || []).filter(r => r.in_current_tracker === true);
  if (!absent.length) {
    console.log('No row is marked as absent from the tracker. Nothing to export.');
    console.log('(If that is unexpected, the import may not have run since '
      + 'migration 104 — it is what sets the flag.)');
    return;
  }

  const pairKey = r => [clean(r.case_number).toLowerCase(), clean(r.work_order).toLowerCase()].join('|');
  const byPair = new Map();
  current.forEach(r => {
    const k = pairKey(r);
    if (!byPair.has(k)) byPair.set(k, []);
    byPair.get(k).push(r);
  });

  const rows = absent.map(r => {
    const matches = byPair.get(pairKey(r)) || [];
    return {
      'Property': r.property_name,
      'Case number': r.case_number || '',
      'Work order': r.work_order || '',
      'Address / unit': r.address_unit || '',
      'Deficiency date': r.deficiency_date || '',
      'Status': r.status || '',
      'Description (this row)': r.deficiency_description || '',
      'Same case + WO as a current row?': matches.length ? 'yes (' + matches.length + ')' : 'no',
      // The text to compare against, so the question is answerable on the
      // sheet rather than by opening the tracker in another window.
      'Description of the current row(s)': matches
        .map(m => clean(m.deficiency_description)).filter(Boolean).join('\n---\n'),
      // Left blank on purpose. The machine says what it can see; the verdict
      // is Erick's.
      'Erick: same thing? (yes / no)': '',
      'Erick: notes': '',
      'Origin': r.updated_by || '',
    };
  }).sort((a, b) =>
    a.Property.localeCompare(b.Property)
    || String(a['Case number']).localeCompare(String(b['Case number'])));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [
    { wch: 22 }, { wch: 18 }, { wch: 12 }, { wch: 34 }, { wch: 14 }, { wch: 24 },
    { wch: 60 }, { wch: 14 }, { wch: 60 }, { wch: 16 }, { wch: 30 }, { wch: 18 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Not in tracker');

  // A second sheet saying what this is, because a workbook that lands in a
  // meeting without its question gets read as a list of errors.
  const about = [
    ['What this is'],
    ['Deficiencies stored in the dashboard that the current SharePoint tracker'],
    ['(Code_Violations_Tracker.xlsx) does not contain. Nothing has been deleted.'],
    [''],
    ['Where they came from'],
    ['50 were written by a seed script before the SharePoint import existed;'],
    ['1 was edited by hand in the dashboard.'],
    [''],
    ['What is NOT being claimed'],
    ['None of these is called a duplicate. ' + rows.filter(r => r['Same case + WO as a current row?'] !== 'no').length
      + ' of ' + rows.length + ' share a case number AND a work order'],
    ['with a row in the current tracker, but none shares the opening description.'],
    ['That is either the same deficiency reworded, or a different deficiency under'],
    ['the same case — one work order routinely covers several. Only somebody'],
    ['reading both descriptions can tell, which is what the two blank columns are for.'],
    [''],
    ['Generated', new Date().toISOString().slice(0, 16).replace('T', ' ') + ' (UTC)'],
  ];
  const aboutWs = XLSX.utils.aoa_to_sheet(about);
  aboutWs['!cols'] = [{ wch: 80 }, { wch: 20 }];
  XLSX.utils.book_append_sheet(wb, aboutWs, 'About');

  require('fs').mkdirSync(path.dirname(OUT), { recursive: true });
  XLSX.writeFile(wb, OUT);

  const withPair = rows.filter(r => r['Same case + WO as a current row?'] !== 'no').length;
  console.log('rows: ' + rows.length);
  console.log('   share case + WO with a current row: ' + withPair);
  console.log('   match nothing in the tracker:       ' + (rows.length - withPair));
  console.log('\nwritten: ' + OUT);
  console.log('exports/ is gitignored — this carries addresses and unit numbers.');
})().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
