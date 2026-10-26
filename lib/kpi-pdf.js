// The Executive KPI Dashboard, as a printable page.
//
// Moved out of server.js on 2026-10-26 so the layout can be rendered and
// measured in a test rather than only by downloading it — the same reason
// lib/oncall-export.js exists. NOTHING ABOUT THE NUMBERS CHANGED in that move;
// what follows is the formatting, and the formatting was broken in two ways
// Katie hit on the 10/18–10/24 week.
//
// ---- 1. THE ROW HEIGHT WAS A CONSTANT ---------------------------------------
//
// Every row advanced `doc.y` by a flat 12pt. A column header like "Ascent at
// Northgate" or "Windy Hill Apartment" does not fit in one 48pt-wide cell at
// 7.5pt, so PDFKit wrapped it to two lines — about 18pt — and the next row was
// drawn 12pt down, on top of it. Every table on the page did this, on the
// header row, which is why the first data row of each was unreadable.
//
// `ellipsis: true` was set and did not save it: PDFKit only ellipsises when the
// text is clipped by a `height`, and no height was given, so it wrapped.
//
// Rows now measure themselves. Each cell is asked how tall it will be at its
// width, and the row advances by the tallest.
//
// ---- 2. THE COLUMNS WERE WIDER THAN THE PAGE --------------------------------
//
//     cw = Math.max(52, Math.min(96, (W - labelW) / columns.length))
//
// The Math.max is a readability floor, and on this week it overrode the only
// constraint that is not negotiable. Twelve columns (eleven properties plus
// Portfolio) over 732pt of landscape LETTER with a 190pt label column leaves
// 45.2pt each; the floor pushed that to 52 and the table to 814pt — 82pt wider
// than the page. PDFKit does not complain, it just draws past the edge, so
// Greystone printed as "Gr" and Portfolio did not print at all.
//
// A floor that is allowed to overflow the page is not a floor, it is a silent
// truncation of the rightmost column. fitLayout() keeps the floor as a
// PREFERENCE and gives up font size, then label width, to honour the page. It
// returns a layout that is guaranteed to fit, or the narrowest one possible,
// and says which.
'use strict';

const { pdfSafe } = require('./pdf-text.js');

// Landscape LETTER with 30pt margins leaves 732 x 552. Everything below is
// derived from the doc, not from those numbers; they are here to read by.
const PREFERRED_COL = 52;      // what a column wants, for legibility
const MIN_COL = 34;            // below this a percentage with a decimal collides
const MAX_COL = 96;
const PREFERRED_LABEL = 190;   // "Rentable Units (excludes unlettable buildings)"
const MIN_LABEL = 120;
const BODY_SIZE = 7.5;
const MIN_BODY_SIZE = 5.5;

/**
 * Column widths and a font size that FIT, rather than ones that look nice and
 * run off the page.
 *
 * Tried in order, because this is the order a reader would give things up in:
 * the full layout, then a smaller font (which lets columns be narrower before
 * digits collide), then the label column, and only then the column floor.
 *
 * @returns {{labelW:number,cw:number,size:number,total:number,fits:boolean}}
 */
function fitLayout(W, nCols, opts) {
  const o = opts || {};
  const minCol = o.minCol || MIN_COL;
  const preferredCol = o.preferredCol || PREFERRED_COL;
  const n = Math.max(1, nCols);

  const widthFor = (labelW, col) => labelW + n * col;
  const sizes = [];
  for (let s = BODY_SIZE; s >= MIN_BODY_SIZE - 1e-9; s -= 0.5) sizes.push(Math.round(s * 2) / 2);

  for (const size of sizes) {
    for (const labelW of [PREFERRED_LABEL, 165, 145, MIN_LABEL]) {
      const avail = W - labelW;
      const natural = avail / n;
      // The column the page can actually afford at this label width.
      const col = Math.min(MAX_COL, natural);
      if (col >= preferredCol) {
        return { labelW, cw: Math.floor(col * 10) / 10, size, total: widthFor(labelW, col), fits: true };
      }
      // Below the preference but still legible at this font size: take it.
      if (col >= minCol * (size / BODY_SIZE)) {
        return { labelW, cw: Math.floor(col * 10) / 10, size, total: widthFor(labelW, col), fits: true };
      }
    }
  }
  // Nothing fits legibly. Return the narrowest that still fits the PAGE —
  // cramped beats cut off, and the caller is told so it can say so.
  const labelW = MIN_LABEL;
  const cw = Math.floor(((W - labelW) / n) * 10) / 10;
  return { labelW, cw, size: MIN_BODY_SIZE, total: widthFor(labelW, cw), fits: false };
}

/**
 * Draw the report.
 *
 * @param {PDFDocument} doc   a pdfkit document, already sized landscape
 * @param {object} report     the built KPI report
 * @param {string|null} only  a single property, or null for every column
 * @param {object} deps       { SECTIONS, rowsForColumns }
 */
function drawKpiPdf(doc, report, only, deps) {
  const SECTIONS = deps.SECTIONS;
  const scope = deps.rowsForColumns(report, only ? [only] : report.columns);
  const L = doc.page.margins.left;
  const W = doc.page.width - L - doc.page.margins.right;
  const bottom = doc.page.height - doc.page.margins.bottom;
  const columns = only ? [only] : report.columns;
  const colOf = name => (name === 'Portfolio' ? report.portfolio : report.properties[name]);

  const lay = fitLayout(W, columns.length);
  const labelW = lay.labelW;
  const cw = lay.cw;
  const size = lay.size;
  const PAD = 4;        // gutter inside a cell
  const ROW_GAP = 3;    // breathing room under a row

  doc.fontSize(16).font('Helvetica-Bold').text('Metric Property Management — Executive KPI Dashboard');
  doc.fontSize(9).font('Helvetica').fillColor('#555')
    .text('Leasing week ' + report.range.from + ' .. ' + report.range.to
      + (only ? '  ·  ' + only : '') + '  ·  generated from the Metric AI Admin Dashboard', { width: W });
  if (!report.workbook.loaded) {
    doc.fillColor('#a00').text(report.workbook.note, { width: W });
  }
  if (!lay.fits) {
    // Said rather than silently cramped. Eleven properties is the portfolio
    // today; if it grows past what a page can hold, the reader should know the
    // columns are tighter than intended instead of wondering.
    doc.fillColor('#a00').fontSize(7)
      .text(columns.length + ' columns do not fit legibly on this page — they are as wide as the page allows.',
        { width: W });
  }
  doc.fillColor('#000').moveDown(0.6);

  const widthOf = i => (i === 0 ? labelW : cw) - PAD;

  // How tall this row will be, before drawing any of it. The header row is the
  // one that matters: its cells are property names and they wrap.
  const heightOfRow = (cells, bold) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
    return cells.reduce((h, c, i) =>
      Math.max(h, doc.heightOfString(String(c), { width: widthOf(i) })), 0);
  };

  const row = (cells, bold) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
    const y = doc.y;
    const h = heightOfRow(cells, bold);
    let x = L;
    cells.forEach((c, i) => {
      doc.text(String(c), x, y, { width: widthOf(i) });
      x += i === 0 ? labelW : cw;
    });
    // MEASURED, not assumed. This was `doc.y = y + 12` and a two-line header
    // was overdrawn by the row beneath it.
    doc.y = y + h + ROW_GAP;
    // AND THE CURSOR GOES BACK TO THE MARGIN. doc.text(s, x, y) leaves doc.x at
    // the last cell it drew, and PDFKit uses doc.x for any later text() given
    // no x — so the next section title rendered at the far right of the page,
    // stacked one character wide, instead of above its table. It did that
    // before this change too; the table was overflowing by 82pt, so the titles
    // were being drawn off the page edge entirely and nobody saw them to
    // report it.
    doc.x = L;
  };

  // A table must not start what it cannot finish: a section heading and its
  // column header alone at the foot of a page, with the data overleaf, is the
  // "split awkwardly" Katie reported alongside the overlap.
  const HEADING_H = 16;
  const ensureRoom = (cells, extraRows) => {
    const need = HEADING_H + heightOfRow(cells, true) + (extraRows || 0) * (size + ROW_GAP + 3);
    if (doc.y + need > bottom) { doc.addPage(); return true; }
    return false;
  };

  SECTIONS.forEach((sec) => {
    const si = SECTIONS.indexOf(sec);
    const headerCells = ['Metric'].concat(columns);
    // Room for the heading, the header row and at least two data rows.
    ensureRoom(headerCells, 2);
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#13294b')
      .text(sec.title, L, doc.y, { width: W }).moveDown(0.15);
    doc.fillColor('#000').fontSize(size);
    row(headerCells, true);

    const cards = (sec.cards || []).concat(sec.funnel || []);
    cards.forEach(card => {
      const cells = [card.label].concat(columns.map(c => {
        const col = colOf(c);
        if (!col) return '';
        const f = (col[si].cards.concat(col[si].funnel || [])).find(x => x.metric === card.metric);
        if (!f || f.value === null || f.value === undefined) return '—';
        // FORMATTED BY THE METRIC, NOT BY THE MAGNITUDE. Unchanged in the move.
        const v = typeof f.value === 'number'
          ? (f.money ? '$' + Math.round(f.value).toLocaleString('en-US')
            : (card.percent ? (f.value * 100).toFixed(1) + '%'
              : String(Math.round(f.value * 100) / 100)))
          : String(f.value);
        return f.source === 'manual' ? v + ' *' : v;
      }));
      // Carry the column header over when a long table breaks, or the rows on
      // page two belong to nothing.
      if (doc.y + heightOfRow(cells) > bottom) {
        doc.addPage();
        doc.fontSize(11).font('Helvetica-Bold').fillColor('#13294b')
          .text(sec.title + ' (continued)', L, doc.y, { width: W }).moveDown(0.15);
        doc.fillColor('#000').fontSize(size);
        row(headerCells, true);
      }
      row(cells);
    });

    if (cards.some(c => c.metric === 'followUpsGoal')) {
      (report.goalNotes || []).filter(n => scope.mine(n.property)).forEach(n => {
        doc.fontSize(7).fillColor('#555')
          .text(pdfSafe(n.property + ': ' + n.text), L, doc.y + 2, { width: W });
      });
      doc.fillColor('#000').fontSize(size);
    }

    if (sec.key === 'occupancy' && scope.anyRentable) {
      const cell = (c, f) => {
        const r = (report.rentable || {})[c];
        return r ? f(r) : '';
      };
      row(['Rentable Units (excludes unlettable buildings)']
        .concat(columns.map(c => String(cell(c, r => r.rentableUnits)))));
      row(['Rentable Occupancy %'].concat(columns.map(c =>
        String(cell(c, r => (r.rentablePct === null ? '—' : (r.rentablePct * 100).toFixed(1) + '%'))))));
      columns.forEach(c => {
        const r = (report.rentable || {})[c];
        if (!r || !r.rules.length) return;
        doc.fontSize(7).fillColor('#555').text(pdfSafe(c + ': ' + r.excludedUnits
          + ' units excluded — ' + r.rules.map(x => x.label + ', ' + x.reason).join('; ')),
        L, doc.y + 2, { width: W });
      });
      (report.rentableAlerts || []).filter(a => scope.mine(a.property)).forEach(a => {
        doc.fontSize(7).fillColor(a.severity === 'alarm' ? '#b00020' : '#555')
          .text(pdfSafe((a.severity === 'alarm' ? 'WARNING: ' : '') + a.property + ': ' + a.text),
            L, doc.y + 2, { width: W });
      });
      doc.fillColor('#000').fontSize(size);
    }
    doc.moveDown(0.5);
  });

  doc.fontSize(7.5).fillColor('#555')
    .text('—  no value for this week.   *  adjusted by hand; the calculated figure is on the Backup sheet of the Excel export.',
      L, doc.y + 6, { width: W });
}

module.exports = {
  drawKpiPdf, fitLayout,
  PREFERRED_COL, MIN_COL, MAX_COL, PREFERRED_LABEL, MIN_LABEL, BODY_SIZE, MIN_BODY_SIZE,
};
