// Turning a ledger description into a PATTERN, so a probe can count what kinds
// of entries exist without printing who they are about.
//
// WHY THIS EXISTS. scripts/probe-deposit-reports.js printed two resident names
// on 2026-10-15, under a banner saying no name was printed. The mistake was an
// assumption, not a typo: I treated `description` as a system label because
// that is what a ledger description usually is, and AppFolio interpolates the
// resident, the property and the unit into it —
//
//     "Resident Security Deposits - <resident>, <property> - <unit>:
//      Transfer of Resident Security Deposits at Move Out"
//
// A field is not safe because of what it is called. The same lesson as
// lib/safe-print.js, and the same answer: mask by DEFAULT and let the
// recognisable parts through, rather than hiding the parts I thought of.
//
// TWO LAYERS, because one is a rule I wrote and rules I write have been wrong:
//
//   1. STRUCTURAL — drop everything between the first " - " and the ":" , which
//      is where AppFolio puts the identifying middle, and collapse digits and
//      runs of capitalised words everywhere else.
//   2. VERIFYING — compare what is left against a list of names actually in
//      our data. Anything that still contains one is replaced wholesale. A
//      pattern nobody can read is a worse outcome than a leak only in the sense
//      that it is less useful, and that is the right way round.

'use strict';

const clean = s => String(s == null ? '' : s).trim();

const NAME_TOKEN = '«name»';
const UNIT_TOKEN = '«unit»';
const NUM_TOKEN = '«n»';

/**
 * A ledger description reduced to its shape.
 *
 * "Resident Security Deposits - Jane Doe, Hyde Park Square - 107: Transfer of
 *  Resident Security Deposits at Move Out"
 *   -> "Resident Security Deposits - «name»: Transfer of Resident Security
 *       Deposits at Move Out"
 */
function pattern(raw) {
  let s = clean(raw);
  if (!s) return '(blank)';

  // 1. The identifying middle: everything from the first " - " to the first ":"
  //    after it. That is where the resident, property and unit live.
  s = s.replace(/\s-\s[^:]{0,120}:/, ' - ' + NAME_TOKEN + ':');

  // 2. Anything that still looks like a unit or an amount.
  s = s.replace(/#?\b\d+[A-Za-z]?\b/g, NUM_TOKEN);

  // 3. Runs of two or more Capitalised Words that are not obviously the
  //    system's own vocabulary. Three words or more is almost always a person
  //    or a property; two is kept only when both words are known terms.
  s = s.replace(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){2,})\b/g, m =>
    (KNOWN_PHRASES.some(p => p.toLowerCase() === m.toLowerCase()) ? m : NAME_TOKEN));

  return s.replace(/\s{2,}/g, ' ').trim();
}

// The system's own vocabulary, so a real label is not masked into uselessness.
// Added only when a probe shows the phrase appearing across many residents,
// which is what makes it the system's words and not somebody's name.
const KNOWN_PHRASES = [
  'Resident Security Deposits',
  'Transfer of Resident Security Deposits',
  'Settlement for unpaid Resident Security Deposits',
  'Final Account Statement',
  'Security Deposit Refund',
  'Prepaid Rent',
  'Late Fee',
];

/**
 * The verifying layer: does this still contain a name we know about?
 *
 * `known` is a list of strings from our own data — resident names, property
 * names. If any appears, the pattern is thrown away rather than printed, and
 * the caller is told how many it had to drop.
 */
function safe(patternText, known) {
  const p = clean(patternText);
  if (!p) return '(blank)';
  const hit = (known || []).some(k => {
    const n = clean(k);
    return n.length > 3 && p.toLowerCase().includes(n.toLowerCase());
  });
  return hit ? '(withheld: still contained a name from our data)' : p;
}

// What a caller should print: patterned, then verified.
function describe(raw, known) {
  return safe(pattern(raw), known);
}

// Grouped counts, ready to print. Nothing here returns an original string.
function tally(rows, field, known) {
  const out = new Map();
  let withheld = 0;
  (rows || []).forEach(r => {
    const p = describe(r && r[field], known);
    if (/^\(withheld/.test(p)) withheld++;
    out.set(p, (out.get(p) || 0) + 1);
  });
  return {
    withheld,
    rows: [...out.entries()].sort((a, b) => b[1] - a[1]).map(([p, n]) => ({ pattern: p, count: n })),
  };
}

module.exports = {
  NAME_TOKEN, UNIT_TOKEN, NUM_TOKEN, KNOWN_PHRASES,
  pattern, safe, describe, tally, clean,
};
