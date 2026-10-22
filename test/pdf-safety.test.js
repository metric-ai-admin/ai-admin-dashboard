// What reaches the page, and whether it fits on it.
//
// The November 2026 on-call PDF had two faults, and neither could be seen
// without opening the finished file:
//
//   * "GROUPS — Red: …", the fairness check and every footnote began under the
//     Week 4 column and ran off the right edge. A single-cell row called
//     text(str, {width}) with no x, and PDFKit keeps the x from the previous
//     call — which was the last column it drew.
//   * Every footnote opened with "Ø=ÜÌ". That was 📌: Helvetica is WinAnsi and
//     cannot encode it. PDFKit does not error, it writes whatever byte the
//     encoder lands on, so it reads as a font problem rather than a code one.
//
// So: render November into a buffer, record every text() call, and measure.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const T = require('../lib/pdf-text.js');
const E = require('../lib/oncall-export.js');
const G = require('../lib/oncall-groups.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

console.log('pdf safety');

// ---- the encoder ---------------------------------------------------------------

t('the bullet survives and the pin does not', () => {
  // U+2022 IS in Windows-1252 (0x95). A blanket "strip above U+00FF" would
  // have thrown away the very character chosen as the replacement.
  assert.strictEqual(T.isEncodable(0x2022), true, 'the bullet was dropped');
  assert.strictEqual(T.isEncodable(0x1F4CC), false);
  assert.strictEqual(T.pdfSafe('📌 Note: something'), '• Note: something');
});

t('a warning sign becomes a word, not nothing', () => {
  // A note that loses its marker still reads. A warning that loses its sign
  // stops looking like a warning.
  assert.strictEqual(T.pdfSafe('⚠ Spills into December'), 'WARNING: Spills into December');
  assert.strictEqual(T.pdfSafe('⚠️ With a variation selector'), 'WARNING: With a variation selector');
});

t('accents and dashes are left alone', () => {
  // José, Raúl, Rentería — the names on this rota are the reason a crude
  // "ASCII only" filter would have been worse than the bug.
  ['José Rentería', 'Raúl Martinez', 'Emerson García', 'a — b', '“quoted”', '€5'].forEach(s => {
    assert.deepStrictEqual(T.unsupported(s), [], s + ' lost a character');
  });
  assert.strictEqual(T.pdfSafe('José Rentería'), 'José Rentería');
});

t('an unknown emoji is dropped, not turned into a box', () => {
  // A replacement character mid-sentence reads as data corruption.
  assert.strictEqual(T.pdfSafe('Done 🎉 today'), 'Done today');
  assert.deepStrictEqual(T.unsupported('🎉').map(u => u.codePoint), ['U+1F389']);
});

// ---- the November page ----------------------------------------------------------

// A rotation shaped like the one that printed wrong: five weeks, both pairs,
// the notes and the fairness line.
function november() {
  const weeks = [
    { label: 'Week 1', range: 'Nov 2 - Nov 8', pair: ['Raul Martinez', 'José Rentería'] },
    { label: 'Week 2', range: 'Nov 9 - Nov 15', pair: ['Emerson Garcia', 'Angel Martinez'] },
    { label: 'Week 3', range: 'Nov 16 - Nov 22', pair: ['Raul Martinez', 'José Rentería'] },
    { label: 'Week 4', range: 'Nov 23 - Nov 29', pair: ['Emerson Garcia', 'Angel Martinez'] },
    { label: 'Week 5', range: 'Nov 30 - Dec 6', pair: ['Raul Martinez', 'José Rentería'],
      spillsInto: 'December' },
  ];
  weeks.forEach(w => {
    w.assign = {};
    G.GROUPS.RED.properties.forEach(p => { w.assign[p] = w.pair.find(x => G.GROUPS.RED.techs.includes(x)); });
    G.GROUPS.BLUE.properties.forEach(p => { w.assign[p] = w.pair.find(x => G.GROUPS.BLUE.techs.includes(x)); });
  });
  return {
    year: 2026, month: 11, monthName: 'November 2026', state: 'pending_approval',
    weeks,
    fairness: { note: 'Raúl and José take three weeks, Emerson and Angel two.' },
    carry: { note: 'October week 5 carries into November' },
    warnings: ['Generated before Bekah approved the group change.'],
  };
}

const PROPS = [
  { name: 'Sunset Palms', units: 36 }, { name: 'The Chateau', units: 30 },
  { name: 'Windy Hill Apartment', units: 72 }, { name: 'The Highlander', units: 49 },
  { name: 'Hyde Park Square', units: 48 }, { name: 'Ascent at Northgate', units: 111 },
  { name: 'iConic Downtown', units: 19 }, { name: 'iConic Round Rock', units: 32 },
];

// Render, recording every text() call with where it was put and how wide it
// was allowed to be.
function renderAndRecord() {
  const pdf = new PDFDocument({ size: 'LETTER', layout: 'landscape', margin: 32 });
  const calls = [];
  const realText = pdf.text.bind(pdf);
  pdf.text = function (text, x, y, opts) {
    // text(str, opts) and text(str, x, y, opts) are both used.
    const o = (typeof x === 'object' && x !== null) ? x : (opts || {});
    const atX = typeof x === 'number' ? x : pdf.x;
    calls.push({
      text: String(text),
      x: atX,
      width: o.width === undefined ? null : o.width,
      measured: pdf.widthOfString(String(text)),
    });
    return realText(text, x, y, opts);
  };
  const chunks = [];
  pdf.on('data', c => chunks.push(c));
  const done = new Promise(r => pdf.on('end', () => r(Buffer.concat(chunks))));
  E.drawPdf(pdf, november(), PROPS, G);
  pdf.end();
  return { calls, done, pageWidth: pdf.page.width, margin: 32 };
}

const run = renderAndRecord();

t('nothing is drawn past the right margin', () => {
  // THE FAULT: full-width blocks inherited the Week 4 column's x and were then
  // given the full page width, so they ran off the edge.
  const limit = run.pageWidth - run.margin;
  const over = run.calls
    .map(c => {
      // With a width the text wraps inside it, so the box is what must fit.
      // Without one, the drawn string is.
      const right = c.x + (c.width === null ? c.measured : c.width);
      return { ...c, right };
    })
    .filter(c => c.right > limit + 0.5)
    .map(c => '"' + c.text.slice(0, 44) + '" x=' + Math.round(c.x)
      + ' right=' + Math.round(c.right) + ' > ' + Math.round(limit));
  assert.deepStrictEqual(over, [], 'these run off the page:\n   ' + over.join('\n   '));
});

t('the full-width blocks start at the left margin', () => {
  // Not merely "they fit" — they have to begin where the table begins, or the
  // page reads as if the notes belong to the last column.
  const blocks = run.calls.filter(c =>
    /^(GROUPS|ROTATION FAIRNESS)/.test(c.text) || /^•/.test(c.text));
  assert.ok(blocks.length >= 3, 'only found ' + blocks.length + ' full-width blocks');
  blocks.forEach(b => assert.strictEqual(Math.round(b.x), run.margin,
    '"' + b.text.slice(0, 40) + '" starts at x=' + Math.round(b.x)));
});

t('every string drawn can be encoded by the font', () => {
  const bad = [];
  run.calls.forEach(c => {
    const u = T.unsupported(c.text);
    if (u.length) bad.push('"' + c.text.slice(0, 40) + '" -> '
      + u.map(x => x.char + ' ' + x.codePoint).join(', '));
  });
  assert.deepStrictEqual(bad, [], 'unencodable characters reach the page:\n   ' + bad.join('\n   '));
});

t('the notes still carry a marker and the spill still warns', () => {
  // Stripping is not the same as fixing: the page has to keep its meaning.
  const all = run.calls.map(c => c.text).join('\n');
  assert.match(all, /• Note:/, 'the notes lost their marker');
  assert.match(all, /WARNING: Spills into/, 'the spill warning lost its sign');
});

t('the document actually renders', () => {
  // A measurement harness that silently produced nothing would pass every
  // assertion above.
  assert.ok(run.calls.length > 20, 'only ' + run.calls.length + ' text calls');
  return run.done.then(buf => {
    assert.ok(buf.length > 1000, 'the PDF is ' + buf.length + ' bytes');
    assert.strictEqual(buf.slice(0, 4).toString(), '%PDF');
  });
});

// ---- the other PDFs in the repo ---------------------------------------------------

t('the KPI owner PDF sanitises what it draws', () => {
  // It used a black triangle (U+25B2) as the alarm marker, on the one line
  // trying to raise an alarm, in a file that goes to a property owner.
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const body = server.slice(server.indexOf('function kpiPdf('),
    server.indexOf('async function kpiComputedValue'));
  assert.ok(!/▲/.test(body), 'the triangle is still being drawn');
  assert.match(body, /kpiPdfSafe\(/, 'nothing is sanitised');
  // The alert TEXT comes from data, so the marker alone is not enough.
  assert.match(body, /kpiPdfSafe\(\(a\.severity === 'alarm'/);
});

t('the AppFolio table PDF is clean', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'appfolio-pdf.js'), 'utf8');
  const lit = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g;
  const bad = new Set();
  let m;
  while ((m = lit.exec(src))) {
    T.unsupported(m[1] || m[2] || '').forEach(u => bad.add(u.char + ' ' + u.codePoint));
  }
  assert.deepStrictEqual([...bad], []);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
