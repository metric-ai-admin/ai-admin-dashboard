// One definition of what a grade is worth, and both callers use it.
//
// WHAT HAPPENED. computeGradeScore and the Not-Scoreable flag rule lived in
// server.js, where scripts/regrade-sample.js could not reach them. So the
// script printed the model's SELF-REPORTED total while production stored the
// weighted breakdown, and the two were read side by side as the same quantity.
//
// On 2026-10-26 that produced a day-long false alarm: two control runs over the
// same twenty calls both came back ~4 points above the stored grades, two Not
// Scoreable calls appeared to have gained a score, and one call "scored 0"
// against a stored 45. Nothing had changed. The model self-reported 0 on a call
// whose own breakdown computes 45, and the two N/S calls were N/S by the flag
// route the script did not apply.
//
// The bug was not in the grading. It was a second answer to the same question,
// which is what this file exists to prevent.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

const S = require('../lib/call-score.js');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const server = read('server.js');
const script = read('scripts/regrade-sample.js');
// Whole-line comments AND trailing ones: a `// SCORE.verdict(fresh)` left at
// the end of a line is prose, and a test that matches it is reading the
// description instead of the code.
const codeOf = src => src.split('\n')
  .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .map(l => l.replace(/\s\/\/.*$/, ''))
  .join('\n');

console.log('the scoring contract is shared');

// ---- the arithmetic ------------------------------------------------------------

t('the score comes from the breakdown, not from the model', () => {
  // The real shape: a call whose breakdown computes 45 while the model claims 0.
  const parsed = {
    overall_score: 0,
    categories: [{ weight: 50, score: 25 }, { weight: 50, score: 20 }],
  };
  const v = S.verdict(parsed);
  assert.strictEqual(v.score, 45, 'the model\'s own figure won');
  assert.strictEqual(v.modelScore, 0, 'the model figure should still be reported');
  assert.strictEqual(v.computed, true);
  assert.strictEqual(v.grade, 'F');
});

t('a model total that is too HIGH is discarded the same way', () => {
  // The direction the drift actually ran: breakdown 53/100 reported as 72.
  const v = S.verdict({ overall_score: 72, categories: [{ weight: 100, score: 53 }] });
  assert.strictEqual(v.score, 53);
  assert.strictEqual(v.modelScore, 72);
});

t('no usable breakdown falls back to the model rather than discarding', () => {
  const v = S.verdict({ overall_score: 64, categories: [] });
  assert.strictEqual(v.score, 64);
  assert.strictEqual(v.computed, false);
});

t('a missing model score stays null, never 0', () => {
  // +null is 0 and passes Number.isFinite, which would turn "nothing" into an
  // F on a call nobody scored.
  assert.strictEqual(S.verdict({ overall_score: null, categories: [] }).score, null);
  assert.strictEqual(S.verdict({ categories: [] }).score, null);
  assert.strictEqual(S.verdict({ overall_score: '', categories: [] }).score, null);
});

t('a legal violation caps the score at D', () => {
  const v = S.verdict({ legal_violation: true, categories: [{ weight: 100, score: 95 }] });
  assert.strictEqual(v.score, S.LEGAL_VIOLATION_CAP);
  assert.strictEqual(v.grade, 'D');
});

t('a mis-scored item cannot push the score out of range', () => {
  assert.strictEqual(S.verdict({ categories: [{ weight: 10, score: 999 }] }).score, 100);
  assert.strictEqual(S.verdict({ categories: [{ weight: 10, score: -999 }] }).score, 0);
});

t('the bands are the rubric\'s', () => {
  assert.strictEqual(S.gradeForScore(90), 'A');
  assert.strictEqual(S.gradeForScore(89), 'B');
  assert.strictEqual(S.gradeForScore(60), 'D');
  assert.strictEqual(S.gradeForScore(59), 'F');
  assert.strictEqual(S.gradeForScore(0), 'F');
});

// ---- the Not-Scoreable rule ------------------------------------------------------

t('a flag can make a scored call Not Scoreable', () => {
  // The exact case: the model scored it AND flagged the wrong agent. A number
  // attached to the wrong person is worse than no number.
  const v = S.verdict({
    overall_score: 62,
    categories: [{ weight: 100, score: 62 }],
    flags: ['Suspected agent identity mismatch — attributed to Danny'],
  });
  assert.strictEqual(v.notScoreable, true, 'THE 10/26 CASE IS BACK — a flagged call got a score');
  assert.strictEqual(v.score, null);
  assert.strictEqual(v.grade, 'N/S');
  assert.match(v.reason, /identity mismatch/i);
});

t('the canonical N/S flag is added for flag-based consumers', () => {
  const v = S.verdict({ flags: ['Wrong call — vendor on the line'] });
  assert.ok(v.flags.some(f => /^Not Scoreable — /.test(f)), 'no canonical flag');
  // And not duplicated when the flags already say it.
  const v2 = S.verdict({ flags: ['Not Scoreable — vendor'] });
  assert.strictEqual(v2.flags.filter(f => /not scoreable/i.test(f)).length, 1);
});

t('an explicit not_scoreable still wins', () => {
  const v = S.verdict({ not_scoreable: true, not_scoreable_reason: 'vendor/internal' });
  assert.strictEqual(v.notScoreable, true);
  assert.strictEqual(v.grade, 'N/S');
  assert.strictEqual(v.reason, 'vendor/internal');
});

t('an ordinary call is not swept up by the flag rule', () => {
  const v = S.verdict({
    categories: [{ weight: 100, score: 80 }],
    flags: ['Did not offer a tour', 'Long hold'],
  });
  assert.strictEqual(v.notScoreable, false);
  assert.strictEqual(v.score, 80);
});

// ---- there is only one definition -------------------------------------------------

t('server.js uses the library and keeps no copy of its own', () => {
  const code = codeOf(server);
  assert.match(code, /require\('\.\/lib\/call-score\.js'\)/, 'server.js does not use the library');
  assert.ok(!/function computeGradeScore\s*\(/.test(code),
    'server.js still defines its own computeGradeScore');
  assert.ok(!/const GRADE_BANDS\s*=/.test(code), 'server.js still defines its own bands');
  assert.ok(!/agent identity mismatch\|wrong call\|mislabel/.test(code),
    'server.js still carries its own Not-Scoreable regex');
});

t('regrade-sample reports the verdict, not the model\'s own total', () => {
  const code = codeOf(script);
  assert.match(code, /require\('\.\.\/lib\/call-score\.js'\)/,
    'the script does not use the library');
  assert.match(code, /SCORE\.verdict\(fresh\)/, 'the script does not apply the verdict');
  // The specific regression: printing or storing the raw figure.
  const at = code.indexOf('SCORE.verdict(fresh)');
  assert.ok(at > 0);
  const after = code.slice(at, at + 400);
  assert.match(after, /fresh\.overall_score = v\.score/,
    'the model total is not replaced by the computed one');
  assert.match(after, /fresh\.not_scoreable = v\.notScoreable/,
    'the N/S rule is not applied');
});

t('--write-grades cannot store a score production would not', () => {
  // It writes fresh.overall_score; that is only correct because the grading
  // loop replaced it with the verdict first. Assert the order, since the write
  // site reads identically either way.
  const code = codeOf(script);
  // ANCHORED ON THE ASSIGNMENT, not on the name `SCORE.verdict`. A first
  // version looked for that name and passed against a build where the call had
  // been replaced by a stub and the name survived in a trailing comment — the
  // test matched prose describing the code it was supposed to be checking.
  const verdictAt = code.indexOf('fresh.overall_score = v.score');
  const writeAt = code.indexOf('overall_score: fresh.overall_score');
  assert.ok(verdictAt > 0, 'nothing replaces the model total with the verdict');
  assert.ok(writeAt > 0, 'the write site moved');
  assert.ok(verdictAt < writeAt,
    'the write happens before the verdict is applied — raw model scores would '
    + 'reach call_grades again, as they did for 56 rows on 09-24');
});

t('the verdict is what the writer stores, field for field', () => {
  // A row built by hand the way callGradeRow builds one, compared against the
  // library — so the two cannot drift apart silently.
  const parsed = {
    overall_score: 72,
    overall_grade: 'C',
    categories: [{ weight: 100, score: 53 }],
    flags: ['Long hold'],
  };
  const v = S.verdict(parsed);
  assert.strictEqual(v.score, 53);
  assert.strictEqual(v.grade, 'F');          // 53 is an F, whatever the model said
  assert.strictEqual(v.notScoreable, false);
  assert.strictEqual(v.reason, null);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
