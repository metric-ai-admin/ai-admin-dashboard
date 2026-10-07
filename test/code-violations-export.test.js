// Exporting the Code Violations tracker.
//
// The shape is the contract. People already read Code_Violations_Tracker.xlsx,
// so an export with the columns in a different order, or a different name on
// one of them, is something they have to learn instead of something they
// recognise. Most of this file pins that order.
//
// The second theme is that the parts which are NOT data say so on their face.
// Closed Cases is derived from status because closed_by and closed_at are
// empty on all 67 rows, and Legend and Read Me are copies of a workbook of
// known age. A reader must not take either for a current record.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const E = require('../lib/code-violations-export.js');
const CV = require('../code-violations.js');
const ACTS = require('../lib/activity-actions.js');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const appjs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// Two properties with cases, one without — the real shape of the portfolio.
const ROWS = [
  { property_name: 'Ascent at Northgate', case_number: '2025-036688 CV', work_order: '14196-1',
    address_unit: '9315 Northgate Blvd - Bldg 5', deficiency_date: '2025-09-12',
    deficiency_description: 'Permitting - stairwell stringer.', status: 'Pending',
    pending_items: 'Permit still not obtained.', completed_items: 'None yet.',
    maintenance_remarks: 'Lopez LLC - no estimate.', client_vendor_remarks: 'Crystal Mendez',
    category: 'Permitting', progress_notes: 'Oldest open item.', notice_date: '2025-09-12',
    due_date: null, updated_at: '2026-09-16T12:00:00+00:00', updated_by: 'Arturo Mendoza' },
  { property_name: 'Ascent at Northgate', case_number: '2026-072573 CV', work_order: '22873-1',
    deficiency_date: '2026-06-08', status: 'Completed by Maintenance',
    completed_items: 'Cleanouts done.', updated_at: '2026-09-23T10:00:00+00:00',
    updated_by: 'Emerson Garcia', due_date: '2026-05-03' },
  { property_name: 'Sunset Palms', case_number: '2025-104408 CV', work_order: '18546-1',
    deficiency_date: '2025-08-18', status: 'Assigned - In Progress',
    updated_at: '2026-08-26T10:00:00+00:00' },
];

// ---- the column contract ----------------------------------------------------
t('the twenty columns are in the order the original uses', () => {
  assert.deepStrictEqual(E.COLUMNS.map(c => c[0]), [
    'Property Name', 'Case Number', 'Work Order', 'Address/Unit', 'Deficiency Date',
    'Deficiency Description', 'Status', 'Date last updated', 'Pending Items',
    'Completed Items', 'Maintenance Remarks', 'Client/Vendor Remarks', 'Category',
    'Month', 'Week Number', 'Year', 'Progress Notes', 'Last Updated', 'Notice Date', 'Due Date',
  ]);
});

const ORIGINAL = 'C:/Users/artur/Downloads/Code_Violations_Tracker.xlsx';
if (fs.existsSync(ORIGINAL)) {
  t('the header matches the real workbook, cell for cell', () => {
    const wb = XLSX.readFile(ORIGINAL);
    const head = XLSX.utils.sheet_to_json(wb.Sheets['Ascent at Northgate'],
      { header: 1, raw: false, defval: '' })[0].map(x => String(x).trim());
    assert.deepStrictEqual(head, E.COLUMNS.map(c => c[0]));
  });
} else {
  console.log('  --  skipped: the original workbook is not on this machine');
}

// ---- the calculated columns -------------------------------------------------
t("Month, Week and Year match the workbook's own formulas", () => {
  // Checked against two real rows of the original: 09/12/2025 reads
  // September / Week 37 / 2025, and 06/08/2026 reads June / Week 24 / 2026.
  assert.deepStrictEqual(E.derived('2025-09-12'), { _month: 'September', _week: 'Week 37', _year: '2025' });
  assert.deepStrictEqual(E.derived('2026-06-08'), { _month: 'June', _week: 'Week 24', _year: '2026' });
});

t('a row with no deficiency date gets blanks, not a guess', () => {
  assert.deepStrictEqual(E.derived(null), { _month: '', _week: '', _year: '' });
  assert.deepStrictEqual(E.derived(''), { _month: '', _week: '', _year: '' });
});

t('a date is never turned into a moment in a timezone', () => {
  // "2026-06-08" read as UTC midnight renders as the 7th in Central.
  assert.strictEqual(E.ymd('2026-06-08'), '2026-06-08');
  assert.strictEqual(E.ymd('2026-09-23T10:00:00+00:00'), '2026-09-23');
  assert.strictEqual(E.ymd(null), null);
});

// ---- rows -------------------------------------------------------------------
t('a row comes out in column order with the calculated cells filled', () => {
  const r = E.rowFor(ROWS[0]);
  assert.strictEqual(r.length, 20);
  assert.strictEqual(r[0], 'Ascent at Northgate');
  assert.strictEqual(r[4], '2025-09-12');          // Deficiency Date
  assert.strictEqual(r[13], 'September');          // Month
  assert.strictEqual(r[14], 'Week 37');            // Week Number
  assert.strictEqual(r[15], '2025');               // Year
  assert.strictEqual(r[18], '2025-09-12');         // Notice Date
});

t('Due Date is blank where none was captured, never inferred', () => {
  // An inferred deadline on a code violation is a liability.
  assert.strictEqual(E.rowFor(ROWS[0])[19], null);
  assert.strictEqual(E.rowFor(ROWS[1])[19], '2026-05-03');
});

t('every property gets a tab, including the ones with no cases', () => {
  const g = E.byProperty(ROWS, CV.PROPERTIES);
  assert.deepStrictEqual([...g.keys()], CV.PROPERTIES);
  assert.strictEqual(g.get('The Chateau').length, 0, 'an empty tab is a statement');
  assert.strictEqual(g.get('Ascent at Northgate').length, 2);
});

t('The Sidney is not in the portfolio', () => {
  // In cession and being hidden in AppFolio (Arturo, 2026-10-07).
  assert.ok(!CV.PROPERTIES.includes('The Sidney'));
});

t('a row for an unexpected property is kept, not dropped', () => {
  const g = E.byProperty([{ property_name: 'Somewhere New', deficiency_date: '2026-01-01' }], CV.PROPERTIES);
  assert.ok(g.has('Somewhere New'), 'a violation must never vanish for being unexpected');
});

// ---- the summary ------------------------------------------------------------
t('the summary counts all seven statuses and totals them', () => {
  const s = E.summary(ROWS, CV.PROPERTIES, CV.STATUSES);
  const ascent = s.rows.find(r => r.property === 'Ascent at Northgate');
  assert.strictEqual(ascent.counts['Pending'], 1);
  assert.strictEqual(ascent.counts['Completed by Maintenance'], 1);
  assert.strictEqual(ascent.total, 2);
  assert.strictEqual(s.grand, 3);
  assert.strictEqual(Object.keys(s.totals).length, 7);
});

t('a status outside the seven is counted somewhere, never silently dropped', () => {
  // The original turns the TOTAL cell red for exactly this. A row that
  // disappears from a count is how a violation gets forgotten.
  const s = E.summary([{ property_name: 'Sunset Palms', status: 'Something Else' }],
    CV.PROPERTIES, CV.STATUSES);
  assert.strictEqual(s.unknown, 1);
  assert.strictEqual(s.rows.find(r => r.property === 'Sunset Palms').total, 1);
  assert.strictEqual(s.grand, 1);
});

// ---- closed cases, derived --------------------------------------------------
t('Closed Cases is built from status, since nothing records a closure', () => {
  const c = E.closedCases(ROWS);
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].case_number, '2026-072573 CV');
  assert.strictEqual(c[0].closed, '2026-09-23', 'the day the row last changed');
  // It must not READ v.closed_by or v.closed_at — both are empty on all 67
  // rows. It does WRITE a closed_by key, from updated_by, which is the point.
  const body = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'code-violations-export.js'), 'utf8')
    .split('function closedCases')[1].split('\n}')[0];
  assert.ok(!/v\.closed_by|v\.closed_at/.test(body),
    'those two columns are empty on every row and must not be relied on');
  assert.ok(/closed_by: v\.updated_by/.test(body));
});

t('both Completed and Closed statuses count as closed', () => {
  assert.ok(E.isClosed('Completed by Maintenance'));
  assert.ok(E.isClosed('Completed - No Need to Bill'));
  assert.ok(E.isClosed('Closed by Code Compliance'));
  assert.ok(!E.isClosed('Assigned - In Progress'));
  assert.ok(!E.isClosed('Pending'));
});

t('the sheet says the closing date is derived', () => {
  const route = server.slice(server.indexOf("app.get('/api/code-violations/export/:format'"));
  assert.ok(/not a verified closing date/.test(route),
    'presenting a guess as a record is the thing to avoid here');
});

// ---- csv --------------------------------------------------------------------
t('the CSV is one file with Property Name on every row', () => {
  const rows = E.flatRows(ROWS, CV.PROPERTIES);
  assert.strictEqual(rows.length, 3);
  assert.ok(rows.every(r => r[0]), 'every row carries its property');
  const csv = E.toCsv(E.COLUMNS.map(c => c[0]), rows);
  assert.ok(csv.startsWith('Property Name,Case Number,'));
  assert.strictEqual(csv.split('\r\n').length, 4);
});

t('a cell that would become a formula is escaped', () => {
  const csv = E.toCsv(['A'], [['=cmd|calc'], ['-5 items remain']]);
  assert.ok(csv.includes("'=cmd|calc"));
  assert.ok(csv.includes("'-5 items remain"), 'a description starting with - is ordinary here');
});

t('commas, quotes and newlines survive', () => {
  const csv = E.toCsv(['A'], [['a, b'], ['he said "no"'], ['line1\nline2']]);
  assert.ok(csv.includes('"a, b"'));
  assert.ok(csv.includes('"he said ""no"""'));
  assert.ok(csv.includes('"line1\nline2"'));
});

// ---- the file name ----------------------------------------------------------
t('the file is named with the date', () => {
  assert.strictEqual(E.fileStamp('2026-10-07'), 'Code_Violations_Tracker_2026-10-07');
  assert.strictEqual(E.fileStamp('2026-10-07T13:00:00Z'), 'Code_Violations_Tracker_2026-10-07');
});

// ---- the route --------------------------------------------------------------
t('exporting needs the same access as reading the tab', () => {
  const line = server.slice(server.indexOf("app.get('/api/code-violations/export/:format'"), 400 +
    server.indexOf("app.get('/api/code-violations/export/:format'"));
  assert.ok(/requireAuth, requireRole\(\.\.\.CODE_VIOLATION_ROLES\)/.test(line),
    'a download URL is the easiest thing in a dashboard to reach without the page');
});

t('only the three formats are served', () => {
  const route = server.slice(server.indexOf("app.get('/api/code-violations/export/:format'"));
  assert.ok(/\['xlsx', 'pdf', 'csv'\]\.includes\(format\)/.test(route));
  assert.ok(/format must be xlsx, pdf or csv/.test(route));
});

t('the format is in the path, so the log can tell them apart', () => {
  assert.ok(/export\/:format/.test(server));
  assert.strictEqual(ACTS.describeRead('/api/code-violations/export/xlsx').label, 'Exported Excel');
  assert.strictEqual(ACTS.describeRead('/api/code-violations/export/pdf').label, 'Exported PDF');
  assert.strictEqual(ACTS.describeRead('/api/code-violations/export/csv').label, 'Exported CSV');
  assert.strictEqual(ACTS.sectionLabel('code-violations'), 'Code Violations');
});

t('Legend and Read Me are labelled as copies of a known date', () => {
  assert.ok(/Reference as of 09\/24\/2026/.test(E.REFERENCE_NOTE));
  assert.ok(/does not maintain this sheet/.test(E.REFERENCE_NOTE));
  const route = server.slice(server.indexOf("app.get('/api/code-violations/export/:format'"));
  assert.ok(/cvExport\.REFERENCE_NOTE/.test(route));
});

t('the PDF is landscape', () => {
  assert.ok(/layout: 'landscape'/.test(server));
});

// ---- the page ---------------------------------------------------------------
t('the Export button offers the three formats', () => {
  assert.ok(/id="cvx-export"/.test(html));
  ['xlsx', 'pdf', 'csv'].forEach(f =>
    assert.ok(new RegExp('data-cvx-format="' + f + '"').test(html), f + ' is missing'));
});

t('it navigates rather than fetching the file into memory', () => {
  assert.ok(/window\.location\.href = '\/api\/code-violations\/export\/' \+ encodeURIComponent/.test(appjs));
});

// ---- the whole workbook, built and read back --------------------------------
t('the workbook has the sheets it is supposed to have, with real dates', () => {
  // Built through the same helpers the route uses, then parsed back, because
  // the thing that matters is what Excel will see.
  const header = E.COLUMNS.map(c => c[0]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Summary']]), 'Summary');
  const aoa = [header].concat(E.byProperty(ROWS, CV.PROPERTIES).get('Ascent at Northgate').map(v => E.rowFor(v)));
  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // The same conversion the route applies.
  E.COLUMNS.forEach((c, col) => {
    if (c[2] !== 'date') return;
    for (let r = 1; r < aoa.length; r++) {
      const ref = XLSX.utils.encode_cell({ r: r, c: col });
      const cell = ws[ref];
      if (!cell || typeof cell.v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(cell.v)) continue;
      const p = cell.v.split('-').map(Number);
      ws[ref] = { t: 'n', v: Math.round((Date.UTC(p[0], p[1] - 1, p[2]) - Date.UTC(1899, 11, 30)) / 86400000), z: 'mm/dd/yyyy' };
    }
  });
  XLSX.utils.book_append_sheet(wb, ws, 'Ascent at Northgate');

  const back = XLSX.read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer', cellDates: true });
  const sheet = back.Sheets['Ascent at Northgate'];
  const dateCell = sheet[XLSX.utils.encode_cell({ r: 1, c: 4 })];   // Deficiency Date
  assert.strictEqual(dateCell.t, 'd', 'Deficiency Date must be a date, not text: ' + JSON.stringify(dateCell));
  assert.strictEqual(dateCell.v.toISOString().slice(0, 10), '2025-09-12',
    'and it must be the same day, not shifted by a timezone');
  const textCell = sheet[XLSX.utils.encode_cell({ r: 1, c: 0 })];
  assert.strictEqual(textCell.v, 'Ascent at Northgate');
});

console.log(`\n${pass} passing`);
