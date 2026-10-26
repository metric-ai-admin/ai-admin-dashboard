// The apply mode can only do the one thing it was approved to do.
//
// It corrects 45 rows whose stored score is not the one their own category
// breakdown produces — the rows scripts/regrade-sample.js wrote on 2026-09-24
// when --write-grades stored the model's self-reported total.
//
// 560 rows in call_grades disagree with their breakdown. 515 of them were
// graded before the computed-score contract existed, when the model's total WAS
// the stored score, and re-scoring those is a different decision about an older
// rubric era. So the scope is pinned in the source, not taken from a flag:
// there is no combination of arguments that aims this at them, or at a nightly
// row, and the guards exit rather than narrowing silently.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

const FILE = 'scripts/call-score-dryrun.js';
const src = fs.readFileSync(path.join(__dirname, '..', FILE), 'utf8');
// Whole-line and trailing comments stripped: prose describing a write is not a
// write, and a test that cannot tell them apart is reading the documentation.
const code = src.split('\n')
  .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .map(l => l.replace(/\s\/\/.*$/, ''))
  .join('\n');

const at = s => code.indexOf(s);

console.log('call-score apply mode');

t('nothing is written without --apply', () => {
  assert.match(code, /const APPLY = process\.argv\.includes\('--apply'\)/,
    'the flag is gone — apply may be on by default');
  // The early return that makes every write below unreachable.
  const guard = at('if (!APPLY)');
  assert.ok(guard > 0, 'the !APPLY guard is gone');
  const writes = [...code.matchAll(/\.(insert|update|upsert|delete)\(/g)].map(m => m.index);
  assert.ok(writes.length > 0, 'no write calls found — the scrape broke');
  writes.forEach(i => assert.ok(i > guard,
    'a write at offset ' + i + ' sits BEFORE the --apply guard'));
});

t('the scope is pinned in the source, not taken from a flag', () => {
  // --writer and --since steer the REPORT. If they could widen what apply
  // writes, one typo would re-score the 515 rows from the older era.
  assert.match(code, /const APPLY_WRITER = 'AI \(rubric v2\.1 regrade\)'/);
  assert.match(code, /const APPLY_DATE = '2026-09-22'/);
  // And they are literals, not derived from argv.
  const w = code.match(/const APPLY_WRITER = [^\n]*/)[0];
  const d = code.match(/const APPLY_DATE = [^\n]*/)[0];
  assert.ok(!/arg\(|argv/.test(w), 'APPLY_WRITER can be set from the command line');
  assert.ok(!/arg\(|argv/.test(d), 'APPLY_DATE can be set from the command line');
});

t('it refuses when the report was widened', () => {
  assert.match(code, /if \(ALL \|\| WRITER !== APPLY_WRITER\)/,
    '--all or --writer no longer blocks apply');
  assert.ok(at('if (ALL || WRITER !== APPLY_WRITER)') < at('.insert('),
    'the scope check runs after the first write');
});

t('it refuses a row outside the pinned scope', () => {
  assert.match(code, /a\.r\.graded_by === APPLY_WRITER/, 'the writer is not re-checked');
  assert.match(code, /a\.r\.call_date === APPLY_DATE/, 'the date is not re-checked');
  assert.match(code, /outOfScope/, 'nothing counts rows outside the scope');
});

t('it refuses when the count is not what was reviewed', () => {
  // A selection that quietly grew is a selection nobody has looked at.
  assert.match(code, /target\.length !== APPLY_EXPECT/, 'the count guard is gone');
  assert.match(code, /const APPLY_EXPECT = Number\(arg\('expect', '45'\)\)/,
    'the expected count is no longer 45 by default');
});

t('THE BACKUP IS WRITTEN AND READ BACK BEFORE call_grades IS TOUCHED', () => {
  // The ordering that matters most. A backup taken after the write, or taken
  // and never verified, is a comfort rather than a safeguard.
  const hist = at("from('call_grades_history').insert(");
  const readBack = at("eq('batch_id', batchId)");
  const update = at('.update(patch)');
  assert.ok(hist > 0, 'no history insert');
  assert.ok(readBack > 0, 'the history is never read back');
  assert.ok(update > 0, 'no correction write');
  assert.ok(hist < readBack, 'the history is read back before it is written');
  assert.ok(readBack < update,
    'call_grades is corrected BEFORE the backup is verified — an unverifiable undo');
});

t('a failed or short backup stops everything', () => {
  // The whole apply region, not just after the insert: the "did we read back
  // every row we are about to change" check runs BEFORE the backup is written,
  // which is the right order and was the wrong place to look for it.
  const seg = code.slice(at('const APPLY = '), at('.update(patch)'));
  assert.match(seg, /histErr/, 'a failed history insert is not checked');
  assert.match(seg, /histCount !== historyRows\.length/, 'a short read-back is not checked');
  assert.match(seg, /fullRows\.length !== target\.length/,
    'the rows backed up are not counted against the rows to be changed');
  // Each of those refuses rather than carrying on with less.
  const postInsert = code.slice(at("from('call_grades_history').insert("), at('.update(patch)'));
  assert.ok((postInsert.match(/process\.exitCode = 2/g) || []).length >= 2,
    'a backup failure does not refuse');
});

t('only the verdict fields are written — provenance is left alone', () => {
  const patch = code.slice(at('const patch = {'), at('.update(patch)'));
  ['overall_score', 'overall_grade', 'not_scoreable', 'not_scoreable_reason', 'flags']
    .forEach(f => assert.ok(patch.includes(f + ':'), 'the patch does not set ' + f));
  // These rows are not being re-graded; their stored score is recomputed from
  // evidence they already carried. Rewriting graded_by would erase which run
  // produced them, and the restore script puts both back.
  assert.ok(!/graded_by:/.test(patch), 'the patch rewrites graded_by');
  assert.ok(!/graded_at:/.test(patch), 'the patch rewrites graded_at');
  assert.ok(!/categories:/.test(patch),
    'the patch rewrites the breakdown — the evidence the score is derived FROM');
});

t('it reads back and re-derives rather than trusting the update', () => {
  // "No error" is not the same claim as "the stored score now equals its
  // breakdown".
  const after = code.slice(at('.update(patch)'));
  // ANCHORED ON THE DERIVATION, not on the names. A first version matched
  // /stillOff/ and /SCORE.verdict\(r\)/ and passed against a build where the
  // filter had been replaced by `const stillOff = []` with the old body left
  // beside it as dead code — both names still present, nothing verified.
  assert.match(after, /const stillOff = after2\.filter\(/,
    'the verification no longer derives from the rows read back');
  assert.match(after, /const after2 = await selectAll\(/,
    'nothing re-reads the rows after the write');
  assert.match(after, /SCORE\.verdict\(r\)/, 'nothing re-derives the verdict');
  assert.match(after, /stillOff\.length/, 'rows that did not take are not reported');
});

t('the restore command is printed, with the real batch id', () => {
  const after = code.slice(at('.update(patch)'));
  assert.match(after, /restore-call-grades\.js --batch ' \+ batchId/,
    'the undo command is missing or does not carry the batch id');
  assert.match(after, /--dry-run/, 'the undo is not offered as a dry run first');
});

t('the batch id cannot collide with a regrade batch', () => {
  // restore-call-grades.js selects by batch_id alone; two runs sharing an id
  // would restore each other's rows.
  assert.match(code, /const batchId = 'scorefix_'/, 'the batch id prefix changed');
  assert.ok(!/const batchId = `regrade_/.test(code),
    'this reuses regrade-sample\'s batch prefix');
  assert.match(code, /stamp/, 'the batch id carries no timestamp');
});

t('the dry run stays the default, and says so', () => {
  const seg = code.slice(at('if (!APPLY)'), at('if (!APPLY)') + 800);
  assert.match(seg, /--apply/, 'the dry run does not say how to apply');
  assert.match(seg, /return;/, 'the dry run falls through into apply');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
