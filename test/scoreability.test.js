// The N/S verdict has to agree with itself.
//
// On the 2026-09-22 regrade eight calls came back with overall_grade "N/S" and
// not_scoreable false. They landed in call_grades as SCOREABLE calls carrying a
// null score, so every average over that day included a null and the N/S count
// read 2 when the real answer was 10. gradeTranscript returned the model's JSON
// verbatim and nothing checked the contract.
const assert = require('assert');
const { normaliseScoreability: n } = require('../call-grading.js');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

console.log('the shape that got through');
t('grade "N/S" with not_scoreable false is reconciled to N/S', () => {
  const g = n({ overall_grade: 'N/S', not_scoreable: false, overall_score: null });
  assert.strictEqual(g.not_scoreable, true);
  assert.strictEqual(g.overall_grade, 'N/S');
  assert.strictEqual(g.overall_score, null);
});
t('and gets a reason rather than a blank', () => {
  const g = n({ overall_grade: 'N/S', not_scoreable: false });
  assert.ok(/without a stated reason/.test(g.not_scoreable_reason));
});
t('the stated reason is kept when there is one', () => {
  const g = n({ overall_grade: 'N/S', not_scoreable: false, not_scoreable_reason: 'wrong number' });
  assert.strictEqual(g.not_scoreable_reason, 'wrong number');
});

console.log('\nthe other direction');
t('not_scoreable true forces grade N/S and a null score', () => {
  const g = n({ overall_grade: 'B', not_scoreable: true, overall_score: 80, not_scoreable_reason: 'voicemail' });
  assert.strictEqual(g.overall_grade, 'N/S');
  assert.strictEqual(g.overall_score, null);
  assert.strictEqual(g.not_scoreable_reason, 'voicemail');
});
t('case and whitespace do not let it through', () => {
  ['n/s', ' N/S ', 'N/s'].forEach(v => {
    assert.strictEqual(n({ overall_grade: v, not_scoreable: false }).not_scoreable, true, v);
  });
});

console.log('\nscoreable calls are untouched');
t('a real grade passes through unchanged', () => {
  const src = { overall_grade: 'B', not_scoreable: false, overall_score: 86, categories: [{ weight: 20, score: 18 }] };
  assert.deepStrictEqual(n(src), src);
});
t('a score of 0 is not mistaken for missing', () => {
  const g = n({ overall_grade: 'F', not_scoreable: false, overall_score: 0 });
  assert.strictEqual(g.overall_score, 0);
  assert.strictEqual(g.not_scoreable, false);
});
t('an empty breakdown on an N/S call is dropped, a real one on a graded call is kept', () => {
  assert.strictEqual(n({ overall_grade: 'N/S', not_scoreable: true, categories: [] }).categories, null);
  const cats = [{ weight: 20, score: 20 }];
  assert.deepStrictEqual(n({ overall_grade: 'A', not_scoreable: false, overall_score: 95, categories: cats }).categories, cats);
});

console.log('\ndegenerate input');
t('null and non-objects survive', () => {
  assert.strictEqual(n(null), null);
  assert.strictEqual(n(undefined), undefined);
  assert.strictEqual(n('nope'), 'nope');
});
t('a missing grade with not_scoreable false is left alone', () => {
  const src = { overall_score: 70, overall_grade: 'C', not_scoreable: false };
  assert.deepStrictEqual(n(src), src);
});

console.log('\ncontract');
t('gradeTranscript routes its result through the normaliser', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'call-grading.js'), 'utf8');
  assert.ok(/return normaliseScoreability\(graded\);/.test(src),
    'gradeTranscript must not return the model JSON verbatim');
});

console.log(`\n${pass} passing`);
