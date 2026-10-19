// Code violation notes, the case view, and the property filter.
//
// Agreed with Jay and Rocío, 2026-10-16/19. Three things these guard:
//
//   * the author of an imported note is NULL and stays null. The SharePoint
//     workbook has twenty columns and not one is an author; names appear only
//     inside sentences ("cancelled 10/07/2026 3:17 PM by Erick Frey"), and a
//     guessed author on a code violation puts a name against words somebody
//     else may have written.
//   * a date we cannot read does not become the import date, which would file
//     the whole thread as written on the day we loaded it.
//   * a property filter that stops filtering shows the entire portfolio under
//     one property's name.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const N = require('../lib/code-violation-notes.js');
const KPI = require('../lib/kpi-report.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

console.log('code violation notes');

// A row in the real shape, from Code_Violations_Tracker.xlsx (read 2026-10-19).
const ROW = {
  'Property Name': 'Ascent at Northgate',
  'Case Number': '2025-035323 CV',
  'Status': 'Pending',
  'Date last updated': '10/12/2026',
  'Pending Items': 'Work order 18518-1 was CANCELLED 10/07/2026.',
  'Completed Items': 'None yet.',
  'Maintenance Remarks': 'WO 18518-1 cancelled 10/07/2026 3:17 PM by Erick Frey.',
  'Client/Vendor Remarks': 'Crystal Mendez, City of Austin Code Compliance',
  'Progress Notes': 'Cited 09/11/2025; work order not created until 02/05/2026.',
  'Last Updated': '10/12/2026',
};

// ---- the author is not invented ---------------------------------------------

t('every imported note has a null author', () => {
  const notes = N.notesFromExcelRow(ROW, { sheet: 'Ascent at Northgate', rowNumber: 4, deficiencyKey: 'k' });
  assert.ok(notes.length > 0);
  notes.forEach(n => assert.strictEqual(n.author, null));
});

t('a name sitting in the prose is NOT pulled out', () => {
  // "by Erick Frey" is right there in the Maintenance Remarks. The whole
  // agreement was not to parse it.
  const notes = N.notesFromExcelRow(ROW, { sheet: 'S', rowNumber: 1, deficiencyKey: 'k' });
  const withErick = notes.find(n => /Erick Frey/.test(n.body));
  assert.ok(withErick, 'the text is kept');
  assert.strictEqual(withErick.author, null, 'but not promoted to the author field');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'code-violation-notes.js'), 'utf8');
  assert.ok(!/\bby\s+\(\?/.test(src) && !/match\([^)]*by\s/.test(src),
    'no pattern anywhere tries to read a name out of a body');
});

t('an unknown author reads as "author not recorded", never as nobody', () => {
  const d = N.describe({ body: 'x', author: null, authored_at: null });
  assert.strictEqual(d.authorLabel, 'author not recorded');
  assert.strictEqual(d.dateLabel, 'date not recorded');
});

t('a note written in the dashboard REQUIRES an author', () => {
  // Otherwise it is indistinguishable from an imported one, and the new path
  // exists precisely because it knows who is typing.
  assert.throws(() => N.dashboardNote({ body: 'x', author: '', deficiencyKey: 'k' }),
    /needs an author/);
  assert.throws(() => N.dashboardNote({ body: '', author: 'Rocío', deficiencyKey: 'k' }),
    /needs a body/);
  assert.throws(() => N.dashboardNote({ body: 'x', author: 'Rocío' }),
    /needs a deficiency or a case/);
  const ok = N.dashboardNote({ body: 'Called the inspector.', author: 'Rocío Hunsberger',
    deficiencyKey: 'k', now: '2026-10-19T12:00:00Z' });
  assert.strictEqual(ok.source, 'dashboard');
  assert.strictEqual(ok.source_row, null, 'and an import can never overwrite it');
});

t('the route takes the author from the session, not the body', () => {
  // A note that says who wrote it is worth something only if the writer could
  // not have chosen the name.
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const route = server.slice(server.indexOf("'/api/code-violations/notes'"));
  const body = route.slice(0, route.indexOf('});'));
  assert.match(body, /req\.user && \(req\.user\.name \|\| req\.user\.email\)/);
  assert.ok(!/author:\s*req\.body/.test(body), 'the body cannot set the author');
});

// ---- dates ------------------------------------------------------------------

t('the workbook date format is read', () => {
  assert.strictEqual(N.excelDate('10/12/2026'), '2026-10-12T00:00:00.000Z');
  assert.strictEqual(N.excelDate('9/5/2026'), '2026-09-05T00:00:00.000Z');
});

t('an unreadable date is null, NOT the import time', () => {
  // Backfilling today would date the whole thread to the day we loaded it and
  // make years of notes look like one afternoon's work.
  ['', null, undefined, 'last week', 'TBD', '13/45/2026'].forEach(v =>
    assert.strictEqual(N.excelDate(v), null, JSON.stringify(v)));
});

t('placeholder text is not imported as a note', () => {
  // "None yet." under a timestamp reads as somebody having checked.
  ['None yet.', 'none', 'N/A', '-', '—', 'TBD', '  '].forEach(v =>
    assert.ok(N.isEmptyNote(v), JSON.stringify(v)));
  assert.ok(!N.isEmptyNote('None of the three were cleared.'),
    'a real sentence that starts with None is a note');
  const notes = N.notesFromExcelRow(ROW, { sheet: 'S', rowNumber: 1, deficiencyKey: 'k' });
  assert.ok(!notes.some(n => /None yet/.test(n.body)));
});

t('re-importing the same row does not duplicate', () => {
  const a = N.notesFromExcelRow(ROW, { sheet: 'Ascent', rowNumber: 4, deficiencyKey: 'k' });
  const b = N.notesFromExcelRow(ROW, { sheet: 'Ascent', rowNumber: 4, deficiencyKey: 'k' });
  assert.deepStrictEqual(a.map(n => n.source_row), b.map(n => n.source_row));
  assert.strictEqual(new Set(a.map(n => n.source_row)).size, a.length,
    'each block gets its own key, so three notes on a row stay three');
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations',
    '102_code_violation_notes.sql'), 'utf8');
  assert.match(sql, /unique index[\s\S]*source_row/);
  assert.match(sql, /where source_row is not null/,
    'dashboard notes have no source_row and must not collide with each other');
});

// ---- the case view ----------------------------------------------------------

const DEFS = [
  { deficiency_key: 'a', case_number: 'C-1', property_name: 'Ascent at Northgate', status: 'Completed by Maintenance' },
  { deficiency_key: 'b', case_number: 'C-1', property_name: 'Ascent at Northgate', status: 'Pending' },
  { deficiency_key: 'c', case_number: 'C-2', property_name: 'Sunset Palms', status: 'Completed by Maintenance' },
  { deficiency_key: 'd', case_number: '', property_name: 'Sunset Palms', status: 'Pending' },
];

t('deficiencies are grouped into the case the City issued', () => {
  const cases = N.byCase(DEFS, []);
  const c1 = cases.find(c => c.caseNumber === 'C-1');
  assert.strictEqual(c1.total, 2);
  assert.strictEqual(c1.done, 1);
  assert.strictEqual(c1.open, 1);
  assert.strictEqual(c1.progress, '1 of 2');
  assert.strictEqual(c1.complete, false);
});

t('a finished case says so', () => {
  const c2 = N.byCase(DEFS, []).find(c => c.caseNumber === 'C-2');
  assert.strictEqual(c2.complete, true);
  assert.strictEqual(c2.progress, '1 of 1');
});

t('a deficiency with no case number is kept, under its own heading', () => {
  // A row that vanishes because a field is blank is the failure this codebase
  // keeps running into.
  const cases = N.byCase(DEFS, []);
  const orphan = cases.find(c => c.unnumbered);
  assert.ok(orphan, 'it is still there');
  assert.strictEqual(orphan.total, 1);
  assert.strictEqual(orphan.caseNumber, null);
});

t('notes attach to their deficiency, and case notes to the case', () => {
  const cases = N.byCase(DEFS, [
    { deficiency_key: 'b', case_number: 'C-1', body: 'on b', author: null, authored_at: null },
    { deficiency_key: null, case_number: 'C-1', body: 'on the case', author: 'Rocío', authored_at: '2026-10-16T00:00:00Z' },
  ]);
  const c1 = cases.find(c => c.caseNumber === 'C-1');
  assert.strictEqual(c1.notes.length, 1, 'the case-level note');
  assert.strictEqual(c1.notes[0].authorLabel, 'Rocío');
  const b = c1.deficiencies.find(d => d.deficiency_key === 'b');
  assert.strictEqual(b.notes.length, 1);
  assert.strictEqual(b.notes[0].authorLabel, 'author not recorded');
  const a = c1.deficiencies.find(d => d.deficiency_key === 'a');
  assert.strictEqual(a.notes.length, 0, 'a note belongs to one deficiency, not the group');
});

t('open work sorts first', () => {
  const cases = N.byCase(DEFS, []);
  assert.ok(cases[0].open > 0);
  assert.strictEqual(cases[cases.length - 1].open, 0);
});

// ---- the property filter ----------------------------------------------------

t('Greystone resolves to the four properties, from kpi-report', () => {
  assert.deepStrictEqual(N.membersOf('Greystone', KPI).sort(),
    ['Hyde Park Square', 'Sunset Palms', 'The Chateau', 'The Highlander']);
  assert.deepStrictEqual(N.membersOf('Round Rock', KPI).sort(),
    ['iConic Downtown', 'iConic Round Rock']);
  // The same four Jay's cv-live.js lists, independently.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'code-violation-notes.js'), 'utf8');
  assert.ok(!/'Hyde Park Square'|'The Highlander'/.test(src),
    'the membership is not restated here — that would be a third copy');
});

t('a single property filters to itself', () => {
  const rows = [{ property_name: 'Hyde Park Square' }, { property_name: 'Ascent at Northgate' }];
  assert.strictEqual(N.filterByProperty(rows, 'Ascent at Northgate', KPI).rows.length, 1);
});

t('no selection means no filter, not an empty list', () => {
  const rows = [{ property_name: 'Hyde Park Square' }, { property_name: 'Ascent at Northgate' }];
  ['', null, undefined, 'all'].forEach(sel => {
    const r = N.filterByProperty(rows, sel, KPI);
    assert.strictEqual(r.rows.length, 2, JSON.stringify(sel));
    assert.strictEqual(r.members, null);
  });
});

t('a group filters to its members and nothing else', () => {
  const rows = [
    { property_name: 'Hyde Park Square' }, { property_name: 'The Chateau' },
    { property_name: 'Ascent at Northgate' }, { property_name: 'iConic Downtown' },
  ];
  const r = N.filterByProperty(rows, 'Greystone', KPI);
  assert.deepStrictEqual(r.rows.map(x => x.property_name), ['Hyde Park Square', 'The Chateau']);
  assert.strictEqual(r.selection, 'Greystone');
});

t('an unrecognised selection does not fall back to everything', () => {
  // A filter that silently stops filtering shows the whole portfolio under one
  // property's name — which reads as that property having every violation in
  // the company.
  const rows = [{ property_name: 'Hyde Park Square' }, { property_name: 'Ascent at Northgate' }];
  const r = N.filterByProperty(rows, 'Somewhere That Does Not Exist', KPI);
  assert.strictEqual(r.rows.length, 0);
  assert.notStrictEqual(r.members, null, 'it is still a filter, just one that matched nothing');
});

t('the filter runs BEFORE the grouping', () => {
  // Grouping first and filtering after would print "3 of 9" above three rows.
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const route = server.slice(server.indexOf("app.get('/api/code-violations'"));
  const body = route.slice(0, route.indexOf('// POST /api/code-violations/notes'));
  assert.ok(body.indexOf('filterByProperty') < body.indexOf('CVN.byCase('),
    'filtered, then grouped');
  assert.match(body, /CVN\.byCase\(picked\.rows/, 'and grouped from the filtered rows');
});

t('a missing notes table costs the thread, not the tab', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const route = server.slice(server.indexOf("app.get('/api/code-violations'"));
  const body = route.slice(0, route.indexOf('// POST /api/code-violations/notes'));
  assert.match(body, /notesAvailable/);
  assert.match(body, /notesRes\.error \? \[\] :/, 'it degrades to no notes');
});

// ---- the SharePoint importer ------------------------------------------------

const IMP = fs.readFileSync(path.join(__dirname, '..', 'scripts',
  'import-code-violations-sharepoint.js'), 'utf8');

t('the workbook is never written to disk', () => {
  // It carries addresses, unit numbers and the names of city officers.
  assert.match(IMP, /read into memory and never written to disk/);
  assert.ok(!/writeFileSync|createWriteStream/.test(IMP));
  assert.match(IMP, /Buffer\.from\(await r\.arrayBuffer\(\)\)/,
    'it is parsed from the response, not saved first');
});

t('excluded properties are listed, not silently dropped', () => {
  // The rule is the shared fragment list, so Brazos or Lily Pad would be
  // caught the same way as The Sidney — not a name typed into this script.
  assert.match(IMP, /EXCLUDED\.propertyIsExcluded\(property\)/);
  assert.match(IMP, /skippedSidney\.push/);
  assert.ok(!/'The Sidney'/.test(IMP), 'no property name is hardcoded');
});

t('the Summary total is reconciled, never assumed', () => {
  assert.match(IMP, /Grand Total says/);
  assert.match(IMP, /DOES NOT RECONCILE/);
  assert.match(IMP, /MISSING, not invented/,
    'a property counted with no detail is reported, not fabricated');
});

t('a sheet it cannot read says so', () => {
  // "Closed Cases" and "Watchlist" have no recognisable header. A sheet
  // silently ignored is indistinguishable from a sheet that was empty.
  assert.match(IMP, /SHEETS NOT READ/);
});

t('the header is found by its columns, not by position', () => {
  // Taking row 0 on faith is how a title line becomes the column names.
  assert.match(IMP, /includes\('Case Number'\) && r\.includes\('Property Name'\)/);
});

t('the sheet tag never reaches the database', () => {
  // __sheet exists only for the by-sheet report. Writing it would add a
  // column the table does not have and fail the whole upsert.
  assert.match(IMP, /const payload = deficiencies\.map\(\(\{ __sheet, \.\.\.d \}\)/);
});

t('a dry run cannot write', () => {
  assert.ok(IMP.indexOf("if (!WRITE)") < IMP.indexOf('.upsert('),
    'the dry-run return is above every write');
});

t('nothing is deleted and both upserts are keyed', () => {
  assert.match(IMP, /onConflict: 'deficiency_key'/);
  assert.match(IMP, /onConflict: 'source_row'/);
  assert.ok(!/\.delete\(/.test(IMP));
  assert.match(IMP, /Nothing was deleted/);
});

t('a row the workbook no longer holds is flagged, not judged and not removed', () => {
  // 39 of the 51 pre-existing rows share a case number AND a work order with
  // something just imported, but not one shares the opening description —
  // either the same deficiency reworded or a different one under the same
  // case, which a single work order routinely covers. The flag records the
  // fact; a person decides what it means.
  assert.match(IMP, /in_current_tracker: false/);
  assert.match(IMP, /conclusion to a person/);
  assert.ok(!/\.delete\(/.test(IMP));
});

t('an empty read cannot flag the whole table as absent', () => {
  // The same rule as markMissingFromFeed: a workbook we failed to open must
  // not mark every stored row as missing from it.
  assert.match(IMP, /if \(payload\.length && trackerColumns\)/);
});

t('an unrun migration costs the flag, not the import', () => {
  // Sending a column that does not exist fails the WHOLE upsert, which would
  // make an unrun migration cost the 78 deficiencies and 360 notes.
  assert.match(IMP, /trackerColumns = false/);
  assert.match(IMP, /strip\(chunk\)/, 'it retries without the optional columns');
  assert.match(IMP, /NOT MARKED — run supabase\/migrations\/104/);
  assert.match(IMP, /run supabase\/migrations\/103/,
    'and the notes failure names the migration that fixes it');
});

// ---- closed cases -----------------------------------------------------------

t('a closed case is read as a case, with items as a number', () => {
  const c = N.closedCaseFromRow({
    Property: 'The Chateau', Items: '3', Status: 'Closed by Code Compliance',
    Resolution: 'Cleared after re-inspection.', Closed: '07/16/2026', 'Closed by': 'Angel Martinez',
  }, { rowNumber: 5 });
  assert.strictEqual(c.items, 3);
  assert.strictEqual(c.closed_at, '2026-07-16');
  assert.strictEqual(c.closed_by, 'Angel Martinez');
  assert.strictEqual(c.source_row, 'Closed Cases|5');
});

t('an empty Items is null, not zero', () => {
  // "We were not told how many" and "none" are different.
  const c = N.closedCaseFromRow({
    Property: 'X', Items: '', Status: 'Closed', Closed: '07/16/2026',
  }, { rowNumber: 2 });
  assert.strictEqual(c.items, null);
});

t('the total row and the footnote are not cases', () => {
  // Recognised by the ABSENCE of the fields a case must have, not by matching
  // the word "Total" — which would miss "TOTAL", "Grand Total", and whatever
  // the next editor types.
  assert.strictEqual(N.closedCaseFromRow(
    { Property: 'Total', Items: '10', Status: '', Resolution: '', Closed: '', 'Closed by': '' },
    { rowNumber: 8 }), null);
  assert.strictEqual(N.closedCaseFromRow(
    { Property: 'Note: these were verified on the ground.', Items: '' },
    { rowNumber: 9 }), null);
  assert.strictEqual(N.closedCaseFromRow({ Property: '' }, { rowNumber: 10 }), null);
});

t('a case number is lifted only when it is really there', () => {
  // A CV number is a strict token with one possible reading. A name in a
  // sentence is an attribution with several, which is why that is refused.
  const withNum = N.closedCaseFromRow({
    Property: 'X', Status: 'Closed', Resolution: 'Case 2026-118455 CV cleared.',
    Closed: '07/16/2026',
  }, { rowNumber: 2 });
  assert.strictEqual(withNum.case_number, '2026-118455 CV');
  const without = N.closedCaseFromRow({
    Property: 'X', Status: 'Closed by Code Compliance', Resolution: 'Cleared on site.',
    Closed: '07/16/2026',
  }, { rowNumber: 3 });
  assert.strictEqual(without.case_number, null, 'null, never guessed');
});

t('the closed label states both unknowns separately', () => {
  assert.strictEqual(N.closedLabel({ closed_at: '2026-07-16', closed_by: 'Erick Frey' }),
    'Closed 2026-07-16 by Erick Frey');
  assert.match(N.closedLabel({ closed_at: '2026-07-16' }), /closer not recorded/);
  assert.match(N.closedLabel({ closed_by: 'Erick Frey' }), /date not recorded/);
  assert.match(N.closedLabel({}), /date and closer not recorded/);
});

t('no deficiency is manufactured from a closed case', () => {
  const imp = fs.readFileSync(path.join(__dirname, '..', 'scripts',
    'import-cv-closed-and-watchlist.js'), 'utf8');
  assert.ok(!/code_violations'\)/.test(imp),
    'the closed-case import never writes to code_violations');
  assert.match(imp, /code_violation_closed_cases/);
  assert.match(imp, /No deficiency was manufactured/);
});

// ---- watchlist --------------------------------------------------------------

t('a work order is separated from the property, with no dash left behind', () => {
  // "WO 23142-1 - Ascent at Northgate" produced "- Ascent at Northgate",
  // a property name with a dash welded on that matches nothing downstream.
  const w = N.watchlistFromRow({
    'Property / Work Order': 'WO 23142-1 - Ascent at Northgate',
    Item: 'Owner visit', 'Why it is not in the AppFolio feed': 'No WO raised', Owner: 'Kara',
  }, { rowNumber: 5 });
  assert.strictEqual(w.work_order, '23142-1');
  assert.strictEqual(w.property_name, 'Ascent at Northgate');
  const w2 = N.watchlistFromRow({
    'Property / Work Order': 'iConic RR — WO 19105-1', Item: 'Pool gate',
  }, { rowNumber: 4 });
  assert.strictEqual(w2.property_name, 'iConic RR');
});

t('a row with no item is not a watchlist entry', () => {
  assert.strictEqual(N.watchlistFromRow({ 'Property / Work Order': 'X', Item: '' }, {}), null);
  assert.strictEqual(N.watchlistFromRow({ 'Property / Work Order': '', Item: 'Y' }, {}), null);
});

t('an existing watchlist row is matched before anything is written', () => {
  // The two stored rows were typed by hand; their property spelling need not
  // match the sheet's, so the item text is what a person would recognise.
  const existing = [{ id: 1, title: 'Resident washer repair (LG washer)', work_order: null }];
  const hit = N.watchlistDuplicate({ title: 'resident washer repair (lg washer)' }, existing);
  assert.ok(hit, 'matched case- and space-insensitively');
  assert.strictEqual(N.watchlistDuplicate({ title: 'Something else' }, existing), null);
  const byWo = N.watchlistDuplicate({ title: 'Different words', work_order: '19105-1' },
    [{ id: 2, title: 'x', work_order: '19105-1' }]);
  assert.ok(byWo, 'or by work order');
});

t('an excluded property never enters the watchlist', () => {
  // The Sidney has a row on that sheet. Importing it would put it back on a
  // screen through a side door after a week of keeping it off the others.
  const imp = fs.readFileSync(path.join(__dirname, '..', 'scripts',
    'import-cv-closed-and-watchlist.js'), 'utf8');
  assert.match(imp, /EXCLUDED\.propertyIsExcluded\(w\.property_name\)/);
  assert.match(imp, /is on the exclusion list/);
  assert.ok(!/'The Sidney'/.test(imp), 'by the shared list, not a name typed here');
});

// ---- hiding the absent rows -------------------------------------------------

t('rows absent from the tracker are hidden but counted', () => {
  // Hidden is not deleted, and a screen that cannot say how many it is hiding
  // is pretending they do not exist.
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const route = server.slice(server.indexOf("app.get('/api/code-violations'"));
  const body = route.slice(0, route.indexOf('// POST /api/code-violations/notes'));
  assert.match(body, /in_current_tracker !== false/, 'hidden by default');
  assert.match(body, /include=absent/, 'and brought back on request');
  assert.match(body, /notInTracker/);
  assert.match(body, /count: absent\.length/, 'the count travels either way');
});

t('the review export names no verdict', () => {
  const exp = fs.readFileSync(path.join(__dirname, '..', 'scripts',
    'export-cv-not-in-tracker.js'), 'utf8');
  assert.match(exp, /Same case \+ WO as a current row\?/);
  // No COLUMN calls a row a duplicate. The word appears in the prose that
  // explains why none of them does, which is the opposite of the problem —
  // so this checks the headers, not the file.
  const headers = [...exp.matchAll(/^\s*'([^']+)':/gm)].map(m => m[1]);
  assert.ok(headers.length > 5, 'the headers were found: ' + headers.length);
  headers.forEach(h => assert.ok(!/duplicate/i.test(h), 'column "' + h + '"'));
  assert.match(exp, /Erick: same thing\? \(yes \/ no\)/, 'the verdict column is left blank');
  assert.match(exp, /Description of the current row\(s\)/,
    'and the text to compare against travels with it');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
