// =====================================================================
// PDF table export for synced AppFolio reports.
//
// The Reports API returns JSON only — this builds a plain, printable
// landscape table from rows we already have on disk. Readable, not fancy.
// =====================================================================

const PDFDocument = require('pdfkit');

const PAGE_MARGIN = 28;
const HEADER_FONT = 7.5;
const BODY_FONT = 7;
const ROW_PAD = 3;
const MAX_COLS = 12;   // beyond this a landscape page is unreadable
const MAX_ROWS = 5000; // keep the file openable

function cellText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * Stream a table PDF to `res`.
 * @param {object}   res      Express response (already given headers by caller)
 * @param {object}   meta     { title, subtitle, fetchedAt, params }
 * @param {string[]} headers  column names
 * @param {object[]} rows     data rows
 */
function streamTablePDF(res, meta, headers, rows) {
  const doc = new PDFDocument({ size: 'LETTER', layout: 'landscape', margin: PAGE_MARGIN });
  doc.pipe(res);

  const cols = headers.slice(0, MAX_COLS);
  const droppedCols = headers.length - cols.length;
  const data = rows.slice(0, MAX_ROWS);
  const droppedRows = rows.length - data.length;

  const usableW = doc.page.width - PAGE_MARGIN * 2;
  const colW = usableW / Math.max(cols.length, 1);

  // ---- Title block ----
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#1a2233').text(meta.title);
  doc.moveDown(0.15);
  doc.font('Helvetica').fontSize(8).fillColor('#6b7689');
  if (meta.subtitle) doc.text(meta.subtitle);
  const bits = [];
  if (meta.fetchedAt) bits.push('Synced: ' + new Date(meta.fetchedAt).toLocaleString());
  bits.push('Rows: ' + rows.length.toLocaleString());
  bits.push('Generated: ' + new Date().toLocaleString());
  doc.text(bits.join('   |   '));
  if (meta.params && Object.keys(meta.params).length) {
    doc.text('Filters: ' + Object.entries(meta.params)
      .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('/') : v}`).join('   '));
  }
  if (droppedCols > 0 || droppedRows > 0) {
    doc.fillColor('#b45309').text(
      `Note: showing first ${cols.length} of ${headers.length} columns` +
      (droppedRows > 0 ? ` and first ${data.length.toLocaleString()} of ${rows.length.toLocaleString()} rows` : '') +
      '. Use Export CSV for the complete data set.');
  }
  doc.moveDown(0.4);

  let y = doc.y;

  const rowHeight = (vals, font, size) => {
    doc.font(font).fontSize(size);
    let h = 0;
    vals.forEach(v => {
      h = Math.max(h, doc.heightOfString(cellText(v), { width: colW - ROW_PAD * 2 }));
    });
    return h + ROW_PAD * 2;
  };

  const drawRow = (vals, { bold = false, fill = null } = {}) => {
    const font = bold ? 'Helvetica-Bold' : 'Helvetica';
    const size = bold ? HEADER_FONT : BODY_FONT;
    const h = rowHeight(vals, font, size);

    // Page break before drawing if it wouldn't fit.
    if (y + h > doc.page.height - PAGE_MARGIN) {
      doc.addPage();
      y = PAGE_MARGIN;
      if (!bold) drawRow(cols, { bold: true, fill: '#eef2f8' }); // repeat header
    }

    if (fill) {
      doc.rect(PAGE_MARGIN, y, usableW, h).fill(fill);
    }
    doc.font(font).fontSize(size).fillColor('#1a2233');
    vals.forEach((v, i) => {
      doc.text(cellText(v), PAGE_MARGIN + i * colW + ROW_PAD, y + ROW_PAD, {
        width: colW - ROW_PAD * 2,
        height: h - ROW_PAD * 2,
        ellipsis: true,
        lineBreak: true,
      });
    });
    // Bottom rule
    doc.moveTo(PAGE_MARGIN, y + h).lineTo(PAGE_MARGIN + usableW, y + h)
       .lineWidth(0.3).strokeColor('#d8dfea').stroke();
    y += h;
  };

  drawRow(cols, { bold: true, fill: '#eef2f8' });
  for (const r of data) drawRow(cols.map(c => r[c]));

  if (!data.length) {
    doc.font('Helvetica-Oblique').fontSize(9).fillColor('#6b7689')
       .text('No rows in this report.', PAGE_MARGIN, y + 8);
  }

  doc.end();
}

module.exports = { streamTablePDF };
