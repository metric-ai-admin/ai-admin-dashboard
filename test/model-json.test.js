// Parsing the model's JSON out of its response.
//
// One call on 2026-09-22 — a 35-second outbound voicemail, 535 characters, pure
// ASCII, no escapes and no braces — failed three separate times with "malformed
// JSON". Nothing in the transcript could break JSON. The response DID parse as
// JSON; it just was not ONLY JSON. The old parser stripped a fence at each end
// of the string and handed the whole remainder to JSON.parse, so one sentence
// of prose lost the entire grading.
const assert = require('assert');
const { parseModelJson, extractJsonObject } = require('../call-grading.js');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

console.log('what was failing');
t('prose before the object', () => {
  const g = parseModelJson('This is an outbound voicemail, so Step 3 applies.\n{"overall_grade":"N/S","not_scoreable":true}');
  assert.strictEqual(g.overall_grade, 'N/S');
});
t('prose after the object', () => {
  const g = parseModelJson('{"overall_grade":"B","overall_score":86}\n\nNote: verify the greeting on playback.');
  assert.strictEqual(g.overall_score, 86);
});
t('prose on both sides', () => {
  const g = parseModelJson('Here is my assessment.\n{"overall_grade":"C"}\nLet me know if you need more.');
  assert.strictEqual(g.overall_grade, 'C');
});

console.log('\nfences');
t('a fenced object still parses', () => {
  assert.strictEqual(parseModelJson('```json\n{"overall_grade":"A"}\n```').overall_grade, 'A');
});
t('a fence with prose around it parses', () => {
  assert.strictEqual(parseModelJson('Result:\n```json\n{"overall_grade":"A"}\n```\nDone.').overall_grade, 'A');
});
t('a bare fence with no language tag parses', () => {
  assert.strictEqual(parseModelJson('```\n{"overall_grade":"F"}\n```').overall_grade, 'F');
});

console.log('\nbraces and quotes inside the JSON itself');
t('a brace inside a string does not end the object early', () => {
  const g = parseModelJson('{"summary":"agent said {hi} to the caller","overall_grade":"C"}');
  assert.strictEqual(g.summary, 'agent said {hi} to the caller');
  assert.strictEqual(g.overall_grade, 'C');
});
t('an escaped quote does not close the string', () => {
  const g = parseModelJson('preamble {"summary":"she said \\"hello\\" twice","overall_grade":"D"} tail');
  assert.strictEqual(g.summary, 'she said "hello" twice');
});
t('a nested object is kept whole', () => {
  const g = parseModelJson('x {"categories":[{"weight":20,"items":[{"score":5}]}],"overall_grade":"B"} y');
  assert.strictEqual(g.categories[0].items[0].score, 5);
  assert.strictEqual(g.overall_grade, 'B');
});
t('a backslash before a quote inside a transcript quote survives', () => {
  const g = parseModelJson('{"note":"path C:\\\\Users\\\\x","overall_grade":"A"}');
  assert.strictEqual(g.note, 'path C:\\Users\\x');
});

console.log('\nstill an error when it genuinely is one');
t('prose with no object at all throws MALFORMED_JSON', () => {
  assert.throws(() => parseModelJson('I cannot grade this call.'), e => e.code === 'MALFORMED_JSON');
});
t('a truncated object throws rather than returning half a grade', () => {
  assert.throws(() => parseModelJson('{"overall_score":86,"summary":"cut off here'),
    e => e.code === 'MALFORMED_JSON');
});
t('empty input throws', () => {
  assert.throws(() => parseModelJson(''), e => e.code === 'MALFORMED_JSON');
  assert.throws(() => parseModelJson(null), e => e.code === 'MALFORMED_JSON');
});
t('the error carries an excerpt for the log, capped at 300 chars', () => {
  try { parseModelJson('x'.repeat(900)); assert.fail('should have thrown'); }
  catch (e) { assert.strictEqual(e.rawExcerpt.length, 300); }
});

console.log('\nextractJsonObject directly');
t('returns null when nothing opens', () => {
  assert.strictEqual(extractJsonObject('no object here'), null);
});
t('returns null when it opens and never closes', () => {
  assert.strictEqual(extractJsonObject('{"a":1'), null);
});
t('takes the outermost object, not the first inner one', () => {
  assert.strictEqual(extractJsonObject('{"a":{"b":1}}'), '{"a":{"b":1}}');
});

console.log(`\n${pass} passing`);
