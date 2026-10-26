#!/usr/bin/env node
//
// Two regrade runs, compared call by call.
//
//   node scripts/regrade-compare.js exports/runA.csv exports/runB.csv
//
// READ ONLY. It reads two CSV files and prints. No database, no Anthropic call,
// no cost, nothing written anywhere.
//
// WHY RUN VS RUN, AND NOT RUN VS STORED. Comparing a fresh run against the
// stored grades answers "has anything changed since September", which is a
// question about the rubric. The question here is narrower and has to hold
// everything else still: grade the SAME twenty transcripts twice under the SAME
// settings and see how far apart the two answers land. Anything that moves is
// the grader disagreeing with itself.
//
// WHAT IT IS LOOKING FOR. On 2026-10-26 the computed score moved ~10 points
// between two runs at the API default temperature, with 7 letter changes and 3
// calls flipping in and out of Not Scoreable. The computed score is
// earned / weight and the DENOMINATOR is whatever the model chose to emit —
// within one rubric that ranges from 5 to 100 on real data — so this reports
// the score difference, the routing difference and the breakdown shape
// side by side. A score that moved while the category set stayed identical is
// per-criterion jitter; one that moved with the category set is not.
'use strict';

const fs = require('fs');

const [, , fileA, fileB] = process.argv;
if (!fileA || !fileB) {
  console.error('Usage: node scripts/regrade-compare.js <runA.csv> <runB.csv>');
  process.exit(2);
}
for (const f of [fileA, fileB]) {
  if (!fs.existsSync(f)) { console.error('No such file: ' + f); process.exit(2); }
}

// A CSV reader that understands the quoting the writer produces ("" for a
// literal quote) rather than splitting on commas and hoping.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift() || [];
  return rows.filter(r => r.length > 1)
    .map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

const num = v => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
const pad = (s, w) => String(s == null || s === '' ? '—' : s).padEnd(w);
const padL = (s, w) => String(s == null || s === '' ? '—' : s).padStart(w);
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const f1 = v => (v == null ? '—' : v.toFixed(1));

const A = parseCsv(fs.readFileSync(fileA, 'utf8'));
const B = parseCsv(fs.readFileSync(fileB, 'utf8'));
const byId = new Map(B.map(r => [r.recording_id, r]));

const tempA = (A[0] || {}).temperature || '?';
const tempB = (B[0] || {}).temperature || '?';

console.log('='.repeat(78));
console.log('run vs run — the grader against itself');
console.log('='.repeat(78));
console.log('A: ' + fileA + '   (temperature ' + tempA + ', ' + A.length + ' calls)');
console.log('B: ' + fileB + '   (temperature ' + tempB + ', ' + B.length + ' calls)');
if (tempA !== tempB) {
  console.log('');
  console.log('NOTE: the two runs used DIFFERENT temperatures. This compares two');
  console.log('settings, not one setting against itself — read it that way.');
}
console.log('');

const pairs = A.map(a => ({ a, b: byId.get(a.recording_id) })).filter(p => p.b);
const missing = A.length - pairs.length;
if (missing) console.log(missing + ' call(s) in A are not in B and are left out.\n');
if (!pairs.length) {
  console.log('No calls in common. Nothing can be concluded.');
  process.exit(1);
}

// ---- per call ------------------------------------------------------------------
console.log('PER CALL');
console.log('  ' + pad('recording', 14) + pad('agent', 13)
  + padL('A', 5) + padL('B', 5) + padL('diff', 6)
  + '  ' + pad('grade', 10) + pad('N/S', 7) + pad('route', 7) + 'breakdown');
console.log('  ' + '-'.repeat(86));

let scoreDiffs = [], letterChanges = 0, nsFlips = 0, routeChanges = 0,
  shapeChanges = 0, bothScored = 0, sameScore = 0;

pairs.forEach(({ a, b }) => {
  const sa = num(a.new_score), sb = num(b.new_score);
  const nsa = a.not_scoreable === 'Y', nsb = b.not_scoreable === 'Y';
  const ga = a.new_grade, gb = b.new_grade;
  const wa = num(a.total_weight), wb = num(b.total_weight);
  const ca = num(a.cat_count), cb = num(b.cat_count);
  const routeSame = (a.rubric_applied || '') === (b.rubric_applied || '');
  const shapeSame = wa === wb && ca === cb;

  if (nsa !== nsb) nsFlips++;
  if (ga !== gb) letterChanges++;
  if (!routeSame) routeChanges++;
  if (!shapeSame) shapeChanges++;
  let diff = null;
  if (!nsa && !nsb && sa != null && sb != null) {
    bothScored++;
    diff = sb - sa;
    scoreDiffs.push(Math.abs(diff));
    if (diff === 0) sameScore++;
  }

  console.log('  ' + pad(String(a.recording_id).slice(-12), 14)
    + pad(String(a.agent || '?').slice(0, 11), 13)
    + padL(nsa ? 'N/S' : sa, 5) + padL(nsb ? 'N/S' : sb, 5)
    + padL(diff == null ? '—' : (diff > 0 ? '+' + diff : diff), 6)
    + '  ' + pad(ga === gb ? ga : ga + '->' + gb, 10)
    + pad(nsa !== nsb ? 'FLIP' : '', 7)
    + pad(routeSame ? '' : 'CHANGED', 7)
    + (shapeSame ? ca + 'cat w=' + wa
      : ca + 'cat w=' + wa + '  ->  ' + cb + 'cat w=' + wb));
});

// ---- the verdict -----------------------------------------------------------------
console.log('');
console.log('THE GRADER AGAINST ITSELF');
console.log('  calls compared            : ' + pairs.length);
console.log('  scored in BOTH runs       : ' + bothScored);
console.log('  identical score           : ' + sameScore + ' of ' + bothScored);
console.log('  mean ABSOLUTE difference  : ' + f1(mean(scoreDiffs)));
console.log('  largest difference        : ' + (scoreDiffs.length ? Math.max(...scoreDiffs) : '—'));
console.log('  letter grade changed      : ' + letterChanges + ' of ' + pairs.length);
console.log('  N/S verdict flipped       : ' + nsFlips + ' of ' + pairs.length);
console.log('');
console.log('WHERE IT CAME FROM');
console.log('  rubric routing changed    : ' + routeChanges + ' of ' + pairs.length);
console.log('  breakdown shape changed   : ' + shapeChanges + ' of ' + pairs.length
  + '   (category count or total weight)');

// The attribution the whole exercise is for.
const movedWithShape = pairs.filter(({ a, b }) => {
  const sa = num(a.new_score), sb = num(b.new_score);
  if (a.not_scoreable === 'Y' || b.not_scoreable === 'Y' || sa == null || sb == null) return false;
  return sa !== sb && (num(a.total_weight) !== num(b.total_weight)
    || num(a.cat_count) !== num(b.cat_count));
}).length;
const movedAlone = pairs.filter(({ a, b }) => {
  const sa = num(a.new_score), sb = num(b.new_score);
  if (a.not_scoreable === 'Y' || b.not_scoreable === 'Y' || sa == null || sb == null) return false;
  return sa !== sb && num(a.total_weight) === num(b.total_weight)
    && num(a.cat_count) === num(b.cat_count);
}).length;
console.log('');
console.log('  of the scores that moved:');
console.log('    with a different breakdown shape : ' + movedWithShape
  + '   <- the denominator, not the judgement');
console.log('    with an IDENTICAL breakdown shape: ' + movedAlone
  + '   <- per-criterion jitter');
console.log('');
if (movedWithShape > 0 && movedWithShape === movedAlone) {
  // A tie used to fall into the "mostly held" branch and read as a verdict.
  console.log('  READ THIS AS: SPLIT EVENLY — ' + movedWithShape + ' each way. Neither cause');
  console.log('  dominates at this sample size, and a conclusion either way would be');
  console.log('  drawn from the tie-break rather than from the data.');
} else if (movedWithShape > movedAlone) {
  console.log('  READ THIS AS: most of the movement is the model choosing a different');
  console.log('  set of criteria, not scoring the same criteria differently. Pinning');
  console.log('  sampling would make that choice repeatable; it would not make the');
  console.log('  denominator stable across calls, which is a code fix.');
} else if (movedAlone > 0 || movedWithShape > 0) {
  console.log('  READ THIS AS: the breakdown shape mostly held and the scores still');
  console.log('  moved, so this is the model judging the same criteria differently —');
  console.log('  which is what pinning sampling addresses.');
} else {
  console.log('  Nothing moved at all.');
}
console.log('');
console.log('='.repeat(78));
console.log('Nothing was written. Both files were read, and no API call was made.');
console.log('='.repeat(78));
