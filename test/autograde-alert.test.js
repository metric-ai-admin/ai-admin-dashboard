// When call grading stops, and who finds out.
//
// It stopped on 2026-10-17 after three calls — the Anthropic balance ran out —
// and nobody knew until the 21st, when Kara's brief said "no calls were graded"
// for the fourth morning and pointed at the Call Analyzer's recordings, which
// were arriving the whole time.
//
// Four things had to be true for that to take four days:
//   * no record of a run, so a blank night left nothing behind
//   * every API failure reported as "Anthropic API error", whatever it was
//   * no alert on the day
//   * one sentence in the brief for two opposite problems
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const CG = require('../call-grading.js');
const C = require('../lib/brief-calls.js');
const B = require('../lib/kara-brief.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const server = read('server.js');

console.log('auto-grade: failure, record, alert');

// ---- 1. the brief says WHICH thing is missing ------------------------------------

const briefFor = arrived => {
  const calls = C.failedCalls([], '2026-10-20', [], { isManaged: () => true, arrived });
  const built = B.build({ calls, properties: [], portfolio: {}, thresholds: [],
    collections: null, occupancy: null, moveOuts: null,
    freshness: { asOf: 'x', lines: [] } });
  return String(B.render(built));
};

t('calls arrived and none were graded: the grader is named', () => {
  // The day this was written, 61 had arrived with transcripts.
  const text = briefFor(61);
  assert.match(text, /61 call\(s\) DID reach the Call Analyzer/);
  assert.match(text, /the grading step is what did not run/);
  assert.ok(!/check the Call Analyzer is still receiving recordings/.test(text),
    'it still sends the reader to the part that was working');
});

t('no calls arrived: the recordings are named', () => {
  const text = briefFor(0);
  assert.match(text, /No calls reached the Call Analyzer either/);
  assert.match(text, /receiving recordings/);
});

t('not knowing is said, not guessed', () => {
  const text = briefFor(null);
  assert.match(text, /could not be checked/);
  assert.ok(!/DID reach|No calls reached/.test(text), 'it picked a side');
});

t('the HTML twin says the same thing', () => {
  // Kara reads the HTML. A caveat that lives in only one renderer is the one
  // that is missing from the version somebody actually opens.
  const html = read('lib/kara-brief-html.js');
  assert.match(html, /DID reach the Call Analyzer/);
  assert.match(html, /could not be checked/);
});

t('the count is of calls, never their content', () => {
  const gather = read('lib/kara-brief-gather.js');
  const block = gather.slice(gather.indexOf('let arrived = null;'),
    gather.indexOf('return CALLS.failedCalls'));
  assert.match(block, /count: 'exact', head: true/);
  assert.ok(!/transcript/.test(block), 'the brief reads transcripts to count them');
});

// ---- 2. the failure has a kind ----------------------------------------------------

t('credit, key and rate limit are told apart', () => {
  // Three problems, three answers — top up, replace the key, wait — reported
  // by the API as three different status codes and by us as one sentence.
  assert.strictEqual(CG.classifyAnthropicError(400,
    'Your credit balance is too low to access the Anthropic API'), 'credit');
  assert.strictEqual(CG.classifyAnthropicError(401, 'invalid x-api-key'), 'auth');
  assert.strictEqual(CG.classifyAnthropicError(403, 'forbidden'), 'auth');
  assert.strictEqual(CG.classifyAnthropicError(429, 'rate_limit_error'), 'rate');
});

t('a request we built wrong is not blamed on the balance', () => {
  // 'other' is the honest answer: it is ours to fix, not a thing to wait out.
  assert.strictEqual(CG.classifyAnthropicError(400, 'max_tokens must be greater than 0'), 'other');
  assert.strictEqual(CG.classifyAnthropicError(529, 'overloaded'), 'other');
});

t('every kind has an action somebody can take', () => {
  ['credit', 'auth', 'rate', 'other'].forEach(k => {
    assert.ok(CG.FAILURE_ACTION[k] && CG.FAILURE_ACTION[k].length > 20, k + ' has no action');
  });
  assert.match(CG.FAILURE_ACTION.credit, /Backfill/, 'it does not say how to catch up');
});

t('both outbound paths carry the kind', () => {
  // Otherwise the classification depends on which function happened to be
  // called, which is the kind of difference nobody finds twice.
  const cg = read('call-grading.js');
  const hits = cg.match(/err\.failureKind = classifyAnthropicError/g) || [];
  assert.strictEqual(hits.length, 2, 'only ' + hits.length + ' path classifies');
});

// ---- 3. the run is recorded ---------------------------------------------------------

t('a row is written for every attempt', () => {
  assert.match(server, /async function recordAutogradeRun/);
  assert.match(server, /from\('autograde_runs'\)\.insert\(row\)/);
});

t('a run that threw is still recorded', () => {
  // The worst night is the one that died before grading anything, and without
  // this it is the one that leaves no row — exactly backwards.
  const at = server.indexOf("autoGradeDay(yesterday, { delayMs: 500 })");
  const block = server.slice(at, at + 1600);
  assert.match(block, /\.catch\(async err =>/);
  assert.match(block, /recordAutogradeRun\(agg, 'cron'\)/);
});

t('a record that cannot be written does not cost the grading', () => {
  const fn = server.slice(server.indexOf('async function recordAutogradeRun'),
    server.indexOf('// WHEN IS A NIGHT WORTH WAKING SOMEBODY FOR'));
  assert.match(fn, /catch \(e\)/);
  assert.match(fn, /run not recorded/);
  // THE CATCH, not the function. There is a `throw` inside the try — it is how
  // a Supabase error reaches the catch — and banning the word outright failed
  // on the line that makes the handler work.
  const handler = fn.slice(fn.indexOf('} catch (e) {'));
  assert.ok(!/throw/.test(handler), 'the catch rethrows and takes the run with it');
  assert.match(handler, /return null/, 'it does not answer the caller');
});

t('the migration grants in the same file', () => {
  // The rule from 112 onward.
  const sql = read('supabase/migrations/113_autograde_runs.sql');
  assert.match(sql, /grant all privileges on table autograde_runs\s+to service_role/);
  assert.match(sql, /grant usage, select on sequence autograde_runs_id_seq/);
  assert.ok(!/to\s+anon/.test(sql));
});

// ---- 4. the alert ---------------------------------------------------------------------

const shouldAlert = new Function('process', 'require',
  server.slice(server.indexOf('const AUTOGRADE_ERROR_FLOOR'),
    server.indexOf('// The mail, and the line the Morning Report reads.'))
  + '\nreturn autogradeShouldAlert;')({ env: {} }, require);

t('a quiet night does not alert', () => {
  // Sunday: no calls, nothing waiting. An alert that cries wolf on Sundays is
  // ignored on the Monday it matters.
  assert.strictEqual(shouldAlert({ total: 0, newly_graded: 0, errors: 0 }), null);
});

t('a re-run over already-graded calls does not alert', () => {
  assert.strictEqual(shouldAlert({ total: 10, newly_graded: 0, already_graded: 10, errors: 0 }), null);
});

t('work waiting and nothing graded alerts', () => {
  const a = shouldAlert({ total: 115, newly_graded: 0, already_graded: 0, errors: 115 });
  assert.ok(a);
  assert.match(a.reason, /115 call\(s\) were waiting and none were graded/);
});

t('errors over the floor alert even when some were graded', () => {
  assert.ok(shouldAlert({ total: 50, newly_graded: 40, already_graded: 0, errors: 10 }));
  assert.strictEqual(shouldAlert({ total: 50, newly_graded: 49, already_graded: 0, errors: 1 }), null,
    'one thin transcript wakes somebody up');
});

t('the same outage is not mailed every night', () => {
  // The balance stays empty until somebody tops it up. A nightly mail saying
  // the same thing is how the third one gets deleted unread.
  const fn = server.slice(server.indexOf('async function alertAutogradeFailure'),
    server.indexOf("// POST /api/sv/grade/backfill"));
  assert.match(fn, /last\.alerted && last\.failure_kind === agg\.failure_kind/);
  assert.match(fn, /already alerted, not mailing again/);
});

t('an alert that could not be sent says so', () => {
  // Otherwise silence means both "nothing broke" and "the alarm is broken".
  const fn = server.slice(server.indexOf('async function alertAutogradeFailure'),
    server.indexOf("// POST /api/sv/grade/backfill"));
  assert.match(fn, /ALERT NOT SENT/);
});

t('it goes to a mailbox, not a person', () => {
  assert.match(server, /AUTOGRADE_ALERT_TO = process\.env\.AUTOGRADE_ALERT_TO/);
  assert.match(server, /support@livewithmetric\.com/);
});

// ---- 5. the Morning Report line -------------------------------------------------------

t('the Morning Report reads the run log, not the absence of grades', () => {
  // "No grades yesterday" is also what a Sunday looks like.
  const fn = server.slice(server.indexOf('async function mrAutogradeState'),
    server.indexOf('function mrProgressLine'));
  assert.match(fn, /from\('autograde_runs'\)/);
  assert.match(fn, /last\.eligible > 0 && last\.graded === 0/);
});

t('the line is absent on a normal morning', () => {
  const at = server.indexOf('if (autograde && autograde.failing) {');
  assert.ok(at > 0, 'the line is unconditional');
  assert.match(server.slice(at, at + 220), /CALL GRADING IS DOWN/);
});

t('a missing table costs the line, not the report', () => {
  const at = server.indexOf('let autograde = null;');
  assert.match(server.slice(at, at + 200), /catch \(e\) \{ autograde = null; \}/);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
