// What an owner's file is allowed to contain.
//
// Greystone's workbook for week 2026-10-17 went out carrying two notes about
// Windy Hill Apartment — another owner's building, named, with a unit number.
// The columns were right; the prose underneath them was pushed from
// report.rentableAlerts with no filter at all.
//
// Three more things were wrong in the same file and all four are guarded here:
// metrics with no source exported as 0, Occupancy % exported as
// 0.846625767, and the rentable rows appeared in files with no rentable
// property in them.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const R = require('../lib/kpi-report.js');
const WEEK = require('../lib/week.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

console.log('what an owner’s export may contain');

// The real builders, lifted out of server.js so the test exercises the
// shipping code rather than a copy of it.
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const code = src.slice(src.indexOf('// WHOSE ROWS BELONG IN THIS FILE.'),
  src.indexOf('function kpiPdf(')) + '\nreturn { kpiSummarySheet, kpiBackupSheet, kpiRowsForColumns };';

// A week shaped like the one that leaked: Windy Hill has an unlettable
// building, Greystone is four other properties.
function makeReport() {
  const metricsFor = n => ({ units: n, occupied: Math.round(n * 0.9), preleased: Math.round(n * 0.9) });
  const props = {};
  [['Hyde Park Square', 48], ['The Chateau', 30], ['Sunset Palms', 36],
    ['The Highlander', 49], ['Windy Hill Apartment', 72], ['Ascent at Northgate', 111]]
    .forEach(([n, u]) => {
      const m = metricsFor(u);
      m.occPct = m.occupied / m.units;
      props[n] = R.sectionsFor(m, { workbook: {}, overrides: {} });
    });
  const greystone = R.rollUp(['Hyde Park Square', 'The Chateau', 'Sunset Palms', 'The Highlander']
    .map(n => { const m = metricsFor({ 'Hyde Park Square': 48, 'The Chateau': 30, 'Sunset Palms': 36, 'The Highlander': 49 }[n]); return m; }),
  R.CARD_METRICS.concat(['units']));
  props.Greystone = R.sectionsFor(greystone, { workbook: {}, overrides: {} });
  return {
    week_ending: '2026-10-17',
    range: { from: '2026-10-11', to: '2026-10-17' },
    columns: Object.keys(props).concat(['Portfolio']),
    properties: props,
    portfolio: R.sectionsFor(greystone, { workbook: {}, overrides: {} }),
    // TWO properties with rentable data, deliberately. With only one, the
    // block gate (anyRentable) hides the alerts on its own and the filter
    // beneath it is never exercised — deleting the filter left the test
    // passing, which is a test that proves nothing. The day a second property
    // gets an unlettable building, its owner's file would carry the first
    // one's notes.
    rentable: {
      'Windy Hill Apartment': {
        rentableUnits: 60, rentablePct: 0.72, excludedUnits: 12,
        rules: [{ label: 'Building 3', reason: 'not lettable' }],
      },
      'Ascent at Northgate': {
        rentableUnits: 100, rentablePct: 0.53, excludedUnits: 11,
        rules: [{ label: 'Building A', reason: 'under renovation' }],
      },
    },
    rentableAlerts: [
      { property: 'Windy Hill Apartment', severity: 'alarm', text: '1 unit in Building 3 reads as occupied (317)' },
      { property: 'Windy Hill Apartment', severity: 'warn', text: 'unit 333 is listed twice' },
      { property: 'Ascent at Northgate', severity: 'warn', text: 'Building A has no meter reading' },
    ],
  };
}

const report = makeReport();
// kpiBuild joined the list when the Summary sheet started printing the as-of
// footer. The harness names every dependency on purpose: a new one shows up
// here as a missing binding rather than as a silently absent line.
const M = new Function('XLSX', 'kpiReport', 'WEEK', 'kpiBuild', 'report', code)(
  XLSX, R, WEEK, require('../lib/kpi-build.js'), report);
const sheetText = cols => XLSX.utils.sheet_to_json(M.kpiSummarySheet(report, cols),
  { header: 1, raw: true, defval: '' }).map(r => r.join(' ')).join('\n');
const sheetRows = cols => XLSX.utils.sheet_to_json(M.kpiSummarySheet(report, cols),
  { header: 1, raw: true, defval: '' });

// ---- 1. one owner's file carries one owner's rows ---------------------------

t('Greystone’s file says nothing about Windy Hill', () => {
  const text = sheetText(['Greystone']);
  assert.ok(!/Windy Hill/.test(text), 'another owner’s property is named in it');
  assert.ok(!/317|333/.test(text), 'another owner’s unit numbers are in it');
});

// PROSE ONLY. Matching bare digits against the whole sheet reads
// 0.8958333333333334 as unit 333 and calls a clean file a leak; the thing
// being looked for is somebody else's words, so look at the text cells.
const proseOf = cols => XLSX.utils.sheet_to_json(M.kpiSummarySheet(report, cols),
  { header: 1, raw: true, defval: '' })
  .flat().filter(v => typeof v === 'string').join('\n');

t('no single-property file carries another property’s notes', () => {
  // Every column, one file each. The leak was one unfiltered array, so the
  // only safe assertion is all of them.
  report.columns.filter(c => c !== 'Portfolio' && c !== 'Windy Hill Apartment').forEach(c => {
    const prose = proseOf([c]);
    assert.ok(!/Windy Hill/.test(prose), c + '’s file names Windy Hill');
    assert.ok(!/Building 3|listed twice|\(317\)/.test(prose),
      c + '’s file carries Windy Hill’s notes');
  });
});

t('a file for one rentable property excludes the other’s notes', () => {
  // The case the block gate cannot cover: this file legitimately shows the
  // rentable rows, so the alerts underneath them do run, and the only thing
  // keeping somebody else's building out of it is the filter.
  const prose = proseOf(['Ascent at Northgate']);
  assert.match(prose, /Building A has no meter reading/, 'it lost its own note');
  assert.ok(!/Windy Hill|Building 3|listed twice/.test(prose),
    'Ascent’s file carries Windy Hill’s notes');
});

t('Windy Hill keeps its own notes', () => {
  // The fix must not be "drop the notes" — they exist to explain why two
  // occupancy numbers differ, to the owner they are about.
  const text = sheetText(['Windy Hill Apartment']);
  assert.match(text, /317/);
  assert.match(text, /Rentable Units/);
});

t('the combined file keeps everything', () => {
  const text = sheetText(report.columns);
  assert.match(text, /Windy Hill/);
  assert.match(text, /317/);
});

t('a group file carries its members’ notes, not strangers’', () => {
  // Greystone speaks for four properties; if one of them had a note it would
  // belong in Greystone's file. Windy Hill is not one of them.
  const scope = M.kpiRowsForColumns(report, ['Greystone']);
  assert.strictEqual(scope.mine('Hyde Park Square'), true, 'a member was excluded');
  assert.strictEqual(scope.mine('Windy Hill Apartment'), false, 'a stranger was included');
});

t('the PDF filters the same way, from the same helper', () => {
  // The printed page is the one people keep; a filter on one side only would
  // make the quieter file the leaky one.
  // Follows the layout into lib/kpi-pdf.js; the filter is the point, not the file.
  const pdf = fs.readFileSync(path.join(__dirname, '..', 'lib', 'kpi-pdf.js'), 'utf8');
  // The drawer is handed the helper now instead of calling it by name, so the
  // assertion is that it scopes from the SAME helper the Excel uses — which is
  // what "from the same helper" meant all along.
  assert.match(pdf, /deps\.rowsForColumns\(report, only \? \[only\] : report\.columns\)/);
  const server2 = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server2, /rowsForColumns: kpiRowsForColumns/,
    'server.js hands the PDF a different scope helper from the Excel');
  assert.match(pdf, /rentableAlerts \|\| \[\]\)\.filter\(a => scope\.mine\(a\.property\)\)/);
  assert.match(pdf, /scope\.anyRentable/);
});

// ---- 2. nothing without a source exports as zero -----------------------------

t('a metric with no source exports empty, not 0', () => {
  // Greystone's file carried "Follow Ups Completed 0" and "Traffic Sources 0"
  // when nothing feeds either.
  const rows = sheetRows(['Greystone']);
  ['Follow Ups Completed', 'Traffic Sources'].forEach(label => {
    const row = rows.find(r => r[0] === label);
    assert.ok(row, label + ' is not in the sheet');
    assert.strictEqual(row[1], '', label + ' exported as ' + JSON.stringify(row[1]));
  });
});

t('the roll-up stops manufacturing the zero', () => {
  // Only the group columns had it: a property with no workbook gets null
  // straight through, the roll-up started every metric at 0 and summed.
  const rolled = R.rollUp([{ units: 10, occupied: 9 }, { units: 20, occupied: 18 }],
    ['units', 'occupied', 'followUps']);
  assert.strictEqual(rolled.units, 30);
  assert.strictEqual(rolled.followUps, null, 'a metric nobody reported came out as 0');
});

t('a real zero is still a zero', () => {
  // The point is to tell "none" from "zero", not to blank both.
  const rolled = R.rollUp([{ units: 10, moveOuts: 0 }, { units: 20, moveOuts: 0 }],
    ['units', 'moveOuts']);
  assert.strictEqual(rolled.moveOuts, 0);
});

t('a percentage is not computed from a missing numerator', () => {
  // null / 5 is 0 in JavaScript, so an occupied nobody reported would have
  // produced 0% occupancy rather than no answer.
  const rolled = R.rollUp([{ units: 10 }, { units: 20 }], ['units', 'occupied']);
  assert.strictEqual(rolled.occupied, null);
  assert.strictEqual(rolled.occPct, null, 'it reported 0% occupancy');
});

// ---- 3. percentages look like percentages -------------------------------------

t('Occupancy % carries a percent format, not a raw ratio', () => {
  const ws = M.kpiSummarySheet(report, ['Hyde Park Square']);
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  const r = rows.findIndex(x => x[0] === 'Occupancy %');
  const cel = ws[XLSX.utils.encode_cell({ r, c: 1 })];
  assert.ok(cel, 'the cell is empty');
  assert.strictEqual(cel.t, 'n', 'it was written as text');
  assert.strictEqual(cel.z, '0.0%', 'Excel will show 0.846625767');
});

t('every percent card is formatted, not just occupancy', () => {
  const pct = R.SECTIONS.flatMap(s => (s.cards || []).concat(s.funnel || []))
    .filter(c => c.percent).map(c => c.label);
  assert.ok(pct.length >= 2, 'expected more than one percent card');
  const ws = M.kpiSummarySheet(report, ['Hyde Park Square']);
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  pct.forEach(label => {
    const r = rows.findIndex(x => x[0] === label);
    if (r < 0) return;
    const cel = ws[XLSX.utils.encode_cell({ r, c: 1 })];
    if (cel && cel.t === 'n') assert.strictEqual(cel.z, '0.0%', label + ' is unformatted');
  });
});

t('an empty cell is left alone', () => {
  // A format on nothing is not a number; it just makes a blank cell look
  // like it failed to load.
  const ws = M.kpiSummarySheet(report, ['Greystone']);
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  const r = rows.findIndex(x => x[0] === 'Follow Ups Completed');
  const cel = ws[XLSX.utils.encode_cell({ r, c: 1 })];
  assert.ok(!cel || cel.t !== 'n', 'an empty metric was written as a number');
});

// ---- 4. the rentable rows belong to the property that has them ------------------

t('the rentable rows do not appear in a file with no such property', () => {
  // Greystone and Hyde Park Square have no unlettable building, so the two
  // rows are not "0" and not blank — they are a question that does not arise.
  assert.ok(!/Rentable Units/.test(sheetText(['Greystone'])));
  assert.ok(!/Rentable Occupancy/.test(sheetText(['Hyde Park Square'])));
});

t('they do appear for Windy Hill and in the combined file', () => {
  assert.match(sheetText(['Windy Hill Apartment']), /Rentable Units/);
  assert.match(sheetText(report.columns), /Rentable Units/);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
