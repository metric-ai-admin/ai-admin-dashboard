// Does the printed KPI dashboard fit on the page, and can you read it?
//
// Katie downloaded the 2026-10-18..10-24 week and hit two faults at once.
//
//   1. Every table's column header overlapped its first data row. Rows
//      advanced doc.y by a flat 12pt, and a header like "Ascent at Northgate"
//      wraps to two lines (~18pt) in a 45pt column at 7.5pt. The row beneath
//      was drawn on top of it. `ellipsis: true` was set and did not help:
//      PDFKit only ellipsises when a `height` clips the text, and none was
//      given, so it wrapped.
//
//   2. Greystone printed as "Gr" and Portfolio not at all. The column width
//      was Math.max(52, Math.min(96, (W - labelW) / n)) — and on twelve
//      columns the natural width is 45.2, so the 52 floor took it to a table
//      814pt wide on a 732pt page. PDFKit draws past the edge without
//      complaining.
//
// A floor allowed to overrun the page is not a floor, it is a silent
// truncation of the rightmost column — and the rightmost column is the
// portfolio total.
//
// WHAT THIS TEST DOES. It draws the real document with a recording wrapper
// around doc.text, so every string's box is known, and then measures: nothing
// past the right margin, no row overlapping the row below it, every column
// present. That is the check a screenshot can only approximate — and it was a
// screenshot that let the next fault through, where section titles rendered at
// the far right because doc.x was left mid-table.
const assert = require('assert');
const PDFDocument = require('pdfkit');
const SECTIONS = require('../lib/kpi-report.js').SECTIONS;
const K = require('../lib/kpi-pdf.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

// The real portfolio's names, because the wrapping is the bug and short names
// would not reproduce it.
const COLUMNS = ['1009 Scenic Drive', 'Ascent at Northgate', 'Hyde Park Square',
  'Sunset Palms', 'The Chateau', 'The Highlander', 'Windy Hill Apartment',
  'iConic Downtown', 'iConic Round Rock', 'Round Rock', 'Greystone', 'Portfolio'];

function fixture() {
  const colFor = () => SECTIONS.map(sec => ({
    cards: (sec.cards || []).map(c => ({ metric: c.metric, value: 42, source: 'appfolio' })),
    funnel: (sec.funnel || []).map(c => ({ metric: c.metric, value: 7, source: 'appfolio' })),
  }));
  const properties = {};
  COLUMNS.filter(c => c !== 'Portfolio').forEach(c => { properties[c] = colFor(); });
  return {
    columns: COLUMNS,
    properties,
    portfolio: colFor(),
    range: { from: '2026-10-18', to: '2026-10-24' },
    workbook: { loaded: true, note: '' },
    goalNotes: [], rentable: {}, rentableAlerts: [],
  };
}

// Draw, and record where every string landed.
function render(report, only) {
  const doc = new PDFDocument({ size: 'LETTER', layout: 'landscape', margin: 30 });
  doc.on('data', () => {});          // drain, so the stream does not buffer forever
  // PAGE NUMBER ON EVERY DRAW. y restarts at the top margin on each new page,
  // so a y of 86 on page 2 compares as "above" a header ending at 107 on page
  // 1. The first version of this harness did not record the page and reported
  // six overlaps on a document that has none — a detector that cried wolf on
  // the very layout it had just been written to approve.
  let page = 1;
  doc.on('pageAdded', () => { page++; });
  const draws = [];
  const realText = doc.text.bind(doc);
  doc.text = function (str, x, y, opts) {
    // PDFKit's signature is (text, x, y, options) or (text, options).
    const o = (typeof x === 'object' && x !== null) ? x : (opts || {});
    const atX = typeof x === 'number' ? x : doc.x;
    const atY = typeof y === 'number' ? y : doc.y;
    const w = o.width || (doc.page.width - doc.page.margins.right - atX);
    let h = 0;
    try { h = doc.heightOfString(String(str), { width: w }); } catch (e) { h = 0; }
    draws.push({ str: String(str), x: atX, y: atY, w, h, page });
    return realText(str, x, y, opts);
  };
  K.drawKpiPdf(doc, report, only || null, {
    SECTIONS,
    rowsForColumns: () => ({ mine: () => true, anyRentable: false }),
  });
  doc.end();
  return { doc, draws };
}

console.log('KPI PDF layout');

// ---- the width that overflowed -----------------------------------------------------

t('twelve columns fit the page, and that is arithmetic not hope', () => {
  // Landscape LETTER, 30pt margins: 792 - 60 = 732.
  const lay = K.fitLayout(732, 12);
  assert.ok(lay.total <= 732,
    'the table is ' + lay.total.toFixed(0) + 'pt wide on a 732pt page');
  assert.strictEqual(lay.fits, true, 'twelve columns should still be legible');
});

t('the old formula is what it is replaced with, and it did not fit', () => {
  // Kept as the regression it is: the exact expression that shipped.
  const W = 732, labelW = 190, n = 12;
  const old = Math.max(52, Math.min(96, (W - labelW) / n));
  assert.ok(labelW + n * old > W,
    'the original formula no longer overflows — this test has lost its point');
});

t('more columns than the page can hold is SAID, not silently cramped', () => {
  const lay = K.fitLayout(732, 40);
  assert.ok(lay.total <= 732, 'forty columns still must not run off the page');
  assert.strictEqual(lay.fits, false, 'forty columns cannot be legible and should say so');
});

t('a single-property export gets a comfortable column', () => {
  const lay = K.fitLayout(732, 1);
  assert.ok(lay.cw >= K.PREFERRED_COL);
  assert.ok(lay.total <= 732);
  assert.strictEqual(lay.size, K.BODY_SIZE, 'one column should not shrink the font');
});

// ---- the page, as drawn -------------------------------------------------------------

t('NOTHING IS DRAWN PAST THE RIGHT MARGIN', () => {
  const { doc, draws } = render(fixture());
  const limit = doc.page.width - doc.page.margins.right + 0.5;   // half a point of slack
  const over = draws.filter(d => d.x + d.w > limit);
  assert.deepStrictEqual(over.map(d => d.str.slice(0, 24) + ' @' + Math.round(d.x)), [],
    'these run off the page: ' + over.length);
});

t('every column header is drawn, Greystone and Portfolio included', () => {
  const { draws } = render(fixture());
  const missing = COLUMNS.filter(c => !draws.some(d => d.str === c));
  assert.deepStrictEqual(missing, [], 'these columns were never drawn: ' + missing.join(', '));
});

t('THE HEADER ROW DOES NOT OVERLAP THE ROW BELOW IT', () => {
  // The fault Katie saw, on every table.
  const { draws } = render(fixture());
  const headers = draws.filter(d => d.str === 'Metric');
  assert.ok(headers.length >= 7, 'expected a header row per section, found ' + headers.length);
  const bad = [];
  headers.forEach(h => {
    // The tallest cell on that header row — the wrapped property names.
    const rowCells = draws.filter(d => d.page === h.page && Math.abs(d.y - h.y) < 0.5);
    const bottom = Math.max(...rowCells.map(d => d.y + d.h));
    // The first thing drawn below it, on the same page region.
    const next = draws
      .filter(d => d.page === h.page && d.y > h.y + 0.5 && d.x === h.x)
      .sort((a, b) => a.y - b.y)[0];
    if (next && next.y < bottom - 0.5) {
      bad.push('"' + next.str.slice(0, 20) + '" at y=' + next.y.toFixed(1)
        + ' under a header ending at ' + bottom.toFixed(1));
    }
  });
  assert.deepStrictEqual(bad, [], 'rows overlap the header:\n   ' + bad.join('\n   '));
});

t('no two label cells are drawn at the same y', () => {
  // A cheap catch-all for a row that advanced by nothing at all.
  const { draws } = render(fixture());
  const L = 30;
  // Keyed by PAGE and y: the top of page 2 is legitimately the same y as the
  // top of page 1.
  const labels = draws.filter(d => d.x === L && d.w > 100)
    .map(d => d.page + '@' + (Math.round(d.y * 10) / 10));
  const dupes = labels.filter((y, i) => labels.indexOf(y) !== i);
  assert.deepStrictEqual([...new Set(dupes)], [], 'two rows share a y: ' + dupes.join(', '));
});

t('section titles start at the left margin', () => {
  // They did not. doc.text(s, x, y) leaves doc.x at the last cell drawn, and a
  // title given no x inherited it — so "Leasing Activity" rendered one word
  // wide against the right edge. Invisible before the width fix, because the
  // table was overflowing and the title went off the page with it.
  const { draws } = render(fixture());
  const titles = SECTIONS.map(s => s.title);
  const stray = draws
    .filter(d => titles.includes(d.str))
    .filter(d => d.x !== 30);
  assert.deepStrictEqual(stray.map(d => d.str + ' @x=' + Math.round(d.x)), [],
    'section titles are not at the margin');
  // And every section title actually appears.
  const missing = titles.filter(ti => !draws.some(d => d.str === ti));
  assert.deepStrictEqual(missing, [], 'missing section titles: ' + missing.join(', '));
});

t('a table that breaks carries its column header over', () => {
  // FORCED, not hoped for. On the real week no section is tall enough to
  // break, so running this against the ordinary fixture asserted nothing at
  // all — the loop body never ran and the test passed by being empty.
  const tall = fixture();
  const fat = SECTIONS.map((sec, i) => (i === 0
    ? Object.assign({}, sec, {
      cards: Array.from({ length: 60 }, (_, k) =>
        ({ label: 'Padding metric number ' + k, metric: 'pad' + k })),
    })
    : sec));
  const colFor = () => fat.map(sec => ({
    cards: (sec.cards || []).map(c => ({ metric: c.metric, value: 1, source: 'appfolio' })),
    funnel: [],
  }));
  tall.properties = {};
  COLUMNS.filter(c => c !== 'Portfolio').forEach(c => { tall.properties[c] = colFor(); });
  tall.portfolio = colFor();

  const doc = new PDFDocument({ size: 'LETTER', layout: 'landscape', margin: 30 });
  doc.on('data', () => {});
  let page = 1;
  doc.on('pageAdded', () => { page++; });
  const draws = [];
  const realText = doc.text.bind(doc);
  doc.text = function (str, x, y, opts) {
    const atX = typeof x === 'number' ? x : doc.x;
    const atY = typeof y === 'number' ? y : doc.y;
    draws.push({ str: String(str), x: atX, y: atY, page });
    return realText(str, x, y, opts);
  };
  K.drawKpiPdf(doc, tall, null, {
    SECTIONS: fat,
    rowsForColumns: () => ({ mine: () => true, anyRentable: false }),
  });
  doc.end();

  const continued = draws.filter(d => / \(continued\)$/.test(d.str));
  assert.ok(continued.length > 0,
    'sixty rows did not break a page — the fixture no longer forces the case');
  continued.forEach(c => {
    const after = draws.filter(d => d.page === c.page && d.y > c.y).sort((a, b) => a.y - b.y)[0];
    assert.ok(after && after.str === 'Metric',
      '"' + c.str + '" is not followed by a column header — the rows on the new '
      + 'page belong to nothing');
  });
});

t('one property still renders, and still fits', () => {
  const { doc, draws } = render(fixture(), 'Greystone');
  const limit = doc.page.width - doc.page.margins.right + 0.5;
  assert.deepStrictEqual(draws.filter(d => d.x + d.w > limit).map(d => d.str), []);
  assert.ok(draws.some(d => d.str === 'Greystone'));
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
