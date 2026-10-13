// The property on a call, as a choice from a list rather than free text.
//
// The old prompt asked for "the property discussed, or 'Unidentified'" and got
// 352 distinct answers over 1,896 calls. Normalising them mapped 293 and left
// 1,462. A free-text field asked of a model is answered in free text, and no
// amount of tidying afterwards changes what the question was — so these tests
// are about the QUESTION, and about everything the answer is not allowed to be.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const CP = require('../lib/call-property.js');
const PA = require('../lib/property-aliases.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};
const src = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

console.log('call property');

// ---- the list --------------------------------------------------------------

t('the list is the eight properties plus two honest answers', () => {
  assert.strictEqual(CP.CHOICES.length, 10);
  PA.CANONICAL.forEach(p => assert.ok(CP.CHOICES.includes(p), p + ' is not offered'));
  assert.ok(CP.CHOICES.includes('Not property-specific'));
  assert.ok(CP.CHOICES.includes('Unknown'));
});

t('"no property" and "property unknown" stay separate answers', () => {
  // Folding them together would hide the difference between "there is nothing
  // to find" and "there is something to find and we have not found it". Only
  // the second is worth any more work, and only the second is what the
  // resident match is for.
  assert.notStrictEqual(CP.NOT_SPECIFIC, CP.UNKNOWN);
  assert.strictEqual(CP.needsProperty(CP.UNKNOWN), true);
  assert.strictEqual(CP.needsProperty(CP.NOT_SPECIFIC), false);
});

t('a property added to the alias table reaches the prompt by itself', () => {
  const block = CP.promptBlock();
  PA.CANONICAL.forEach(p => assert.ok(block.includes('"' + p + '"'), p + ' is missing'));
  assert.ok(/CLOSED LIST/.test(block));
  assert.ok(/worse than "Unknown"/.test(block), 'it does not discourage guessing');
});

// ---- forcing an answer onto the list ---------------------------------------

t('an exact choice passes through', () => {
  CP.CHOICES.forEach(c => assert.strictEqual(CP.fromGrader(c), c));
});

t('an old spelling still lands, through the alias table', () => {
  assert.strictEqual(CP.fromGrader('Windy Hill'), 'Windy Hill Apartment');
  assert.strictEqual(CP.fromGrader('Iconic Round Rock'), 'iConic Round Rock');
  assert.strictEqual(CP.fromGrader('Hyde Park'), 'Hyde Park Square');
});

t('ANYTHING that will not map becomes Unknown, never free text', () => {
  // The 310 spellings that survived the normalisation are the test set here.
  ['Unidentified', '803 Tirado Street', 'Ventura North (not a Metric property)',
    'Multiple Metric Properties', 'Hyde Park West', 'the one in Kyle', '', null,
    undefined, 'Brazos Lofts (no longer managed)', 'Aspen Apartments']
    .forEach(v => {
      const out = CP.fromGrader(v);
      assert.strictEqual(out, 'Unknown', String(v) + ' -> ' + out);
    });
});

t('every possible output is on the list', () => {
  // The property column cannot contain a value the reports cannot group. That
  // is the whole point, so it is asserted over junk as well as near-misses.
  ['Windy Hill', 'WINDY HILL APARTMENT', 'nonsense', '', '12345', 'Unknown',
    'not property-specific', 'Ascend'].forEach(v =>
    assert.ok(CP.CHOICES.includes(CP.fromGrader(v)), v + ' escaped the list'));
});

t('case is not a reason to lose an answer', () => {
  assert.strictEqual(CP.fromGrader('not property-specific'), 'Not property-specific');
  assert.strictEqual(CP.fromGrader('UNKNOWN'), 'Unknown');
});

// ---- what still needs filling ----------------------------------------------

t('needsProperty is true for the 995 and false for a real property', () => {
  ['Unidentified', 'Unknown', '', null, 'Multiple Metric Properties', '803 Tirado Street']
    .forEach(v => assert.strictEqual(CP.needsProperty(v), true, String(v)));
  PA.CANONICAL.forEach(p => assert.strictEqual(CP.needsProperty(p), false, p));
});

// ---- the wiring ------------------------------------------------------------

t('the built prompt carries the closed list, not the old text box', () => {
  const p = fs.readFileSync(path.join(__dirname, '..', 'call-grade-prompt.json'), 'utf8');
  assert.ok(!/the property discussed, or 'Unidentified'/.test(p),
    'the free-text question is still being asked');
  assert.ok(/CHOICE FROM A CLOSED LIST/.test(p));
  PA.CANONICAL.forEach(n => assert.ok(p.includes(n), n + ' is not offered to the model'));
  assert.ok(p.includes('Not property-specific') && p.includes('Unknown'));
});

t('the builder generates the list instead of restating it', () => {
  // Two copies of the property list would drift the first time one changed.
  const b = src('scripts/build-grade-prompt.js');
  assert.ok(/call-property\.js'\)\.promptBlock\(\)/.test(b),
    'the list is written out in the builder');
});

t('the grader\'s answer is forced onto the list before it is stored', () => {
  const s = src('server.js');
  const at = s.indexOf('property_name:     CALL_PROPERTY.fromGrader');
  assert.ok(at > 0, 'the raw model string is stored again');
  assert.ok(/property_source:   CALL_PROPERTY\.SOURCE\.GRADER/.test(s.slice(at, at + 900)));
  // Bound at the top of the file: an identifier that only resolves when the
  // route runs is how "AFP is not defined" shipped with a green suite.
  assert.ok(/^const CALL_PROPERTY = require\('\.\/lib\/call-property\.js'\);$/m.test(s));
});

t('a missing property_source column does not lose the grade', () => {
  const s = src('server.js');
  const m = s.match(/const CALL_GRADE_V2_COLS = \[[^\]]*\]/);
  assert.ok(m && /property_source/.test(m[0]),
    'a deploy before migration 092 would drop every grade in the run');
});

// ---- the backfill ----------------------------------------------------------

t('the fill is dry-run by default, backs up, and never re-grades', () => {
  const s = src('scripts/fill-call-properties.js');
  assert.ok(/DRY RUN/.test(s) && /--write/.test(s));
  assert.ok(/call_grades_property_fill_/.test(s), 'there is no backup');
  assert.ok(!/anthropic|gradeTranscript|GRADE_MODEL/i.test(s),
    'it calls the model — the whole point is that it does not');
  assert.ok(/property_source: CP\.SOURCE\.MATCH/.test(s), 'the origin is not recorded');
});

t('a shared number is left alone, not attributed', () => {
  // 18 of them cross the directory. Each is a case where somebody would read a
  // confident property off a call that might have been the other household's.
  const s = src('scripts/fill-call-properties.js');
  assert.ok(/who\.size > 1/.test(s), 'a shared number is attributed to one resident');
  assert.ok(/p\.size !== 1/.test(s), 'a resident at two properties is guessed at');
});

t('"Not property-specific" is never overwritten by the match', () => {
  // A correct "this was a vendor" must not become the property of whoever owns
  // the phone number.
  assert.strictEqual(CP.needsProperty('Not property-specific'), false);
  const s = src('scripts/fill-call-properties.js');
  assert.ok(/CP\.needsProperty/.test(s), 'it picks its own rows instead of asking');
});

t('the normalisation marks its rows differently from the match', () => {
  const s = src('scripts/normalize-call-properties.js');
  assert.ok(/SOURCE\.NORMALISED/.test(s));
  assert.notStrictEqual(CP.SOURCE.NORMALISED, CP.SOURCE.MATCH);
  assert.notStrictEqual(CP.SOURCE.GRADER, CP.SOURCE.MATCH);
});

t('an undo clears the source as well as the name', () => {
  // Leaving property_source reading 'resident_match' over a restored value
  // would be a worse state than the one being undone.
  const s = src('scripts/restore-call-properties.js');
  assert.ok(/property_source: null/.test(s));
});

t('migration 092 adds the column without touching a row', () => {
  const sql = src('supabase/migrations/092_call_grades_property_source.sql');
  assert.ok(/ADD COLUMN IF NOT EXISTS property_source/.test(sql));
  assert.ok(!/UPDATE |DELETE /.test(sql), 'it rewrites rows');
});

// ---- the reports -----------------------------------------------------------

t('the screen shows a property, never a placeholder', () => {
  const app = src('public/app.js');
  assert.ok(/function cqaProperty/.test(app));
  const fn = app.slice(app.indexOf('function cqaProperty'), app.indexOf('function cqaProperty') + 450);
  ['Unidentified', 'Unknown', 'Not property-specific'].forEach(v =>
    assert.ok(fn.includes(v), v + ' would be rendered as a location'));
  // And no caller still does the old inline check, which only knew one of them.
  assert.ok(!/property_name !== 'Unidentified'/.test(app),
    'a call pin still reads the old single-value check');
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
