// What can actually be drawn with PDFKit's standard fonts.
//
// Helvetica, Times and Courier are the fonts PDFKit ships without embedding
// anything, and they are encoded as WinAnsi — Windows-1252. A character
// outside that set does not error: it is written as whatever byte the encoder
// lands on, so the on-call PDF for November 2026 opened with "Ø=ÜÌ" at the
// start of every footnote. That was 📌.
//
// It is the same failure shape as a silently ignored API parameter: nothing
// complains, and the output looks like a font problem rather than a code one.
//
// THE EXCEL IS UNAFFECTED. XLSX is UTF-8 and the emoji render there; this is
// only about the PDF path.

'use strict';

// Windows-1252 is Latin-1 plus 27 printable characters in 0x80-0x9F. Those 27
// are the ones that make this list worth writing out: the bullet, the dashes
// and the curly quotes ARE encodable, and a blanket "strip anything above
// U+00FF" would have thrown away the bullet this module recommends as the
// replacement.
const CP1252_HIGH = new Set([
  0x20AC, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x017D, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022,
  0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x017E, 0x0178,
]);

function isEncodable(cp) {
  // Tab, newline and carriage return are fine — PDFKit handles them as layout.
  if (cp === 0x09 || cp === 0x0A || cp === 0x0D) return true;
  if (cp < 0x20) return false;
  if (cp <= 0xFF) return cp !== 0x7F;      // Latin-1, minus DEL
  return CP1252_HIGH.has(cp);
}

// Symbols that carry meaning, mapped rather than dropped. A note that loses
// its marker still reads; a warning that loses its sign stops looking like a
// warning, so that one becomes a word.
const REPLACEMENTS = [
  [/📌/g, '•'],      // pin -> bullet (U+2022 IS in WinAnsi)
  [/⚠️?/g, 'WARNING:'],   // with and without the variation selector
  [/[✅✔]/g, 'OK'],
  [/[❌✖]/g, 'X'],
  [/[🔴🟡🟢🔵⚫⚪]/g, '•'],
  [/[→➔]/g, '->'],
  [/[—–]/g, '–'],    // already encodable; normalised so widths are stable
  [/ /g, ' '],       // non-breaking space measures oddly in some viewers
];

/**
 * A string safe to draw with a standard PDFKit font.
 *
 * Known symbols are translated, and anything still unencodable is DROPPED
 * rather than substituted with a box — a replacement character in the middle
 * of a sentence is noise that looks like data corruption to a reader.
 */
function pdfSafe(s) {
  let out = String(s === null || s === undefined ? '' : s);
  REPLACEMENTS.forEach(([re, to]) => { out = out.replace(re, to); });
  out = [...out].filter(ch => isEncodable(ch.codePointAt(0))).join('');
  // A line that was only an emoji leaves a leading space behind.
  return out.replace(/\s{2,}/g, ' ').trim();
}

/**
 * The characters in a string that a standard font cannot draw.
 *
 * Used by the tests, which is the point: the check runs on the strings the
 * code actually hands to PDFKit, not on a list somebody keeps by hand.
 *
 * @returns {{char: string, codePoint: string}[]}
 */
function unsupported(s) {
  const out = [];
  const seen = new Set();
  [...String(s === null || s === undefined ? '' : s)].forEach(ch => {
    const cp = ch.codePointAt(0);
    if (isEncodable(cp)) return;
    if (seen.has(ch)) return;
    seen.add(ch);
    out.push({ char: ch, codePoint: 'U+' + cp.toString(16).toUpperCase().padStart(4, '0') });
  });
  return out;
}

module.exports = { pdfSafe, unsupported, isEncodable, CP1252_HIGH, REPLACEMENTS };
