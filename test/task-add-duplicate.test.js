// "+ Add Task" created the same task twice on 2026-10-02.
//
// The POST was still in flight, nothing on screen said so, and a second click
// made a second task — both returned 200, ten seconds apart, and both show in
// activity_log. The fix is two separate things, and the one that looks obvious
// is not the one that caused it:
//
//   1. the button stays live while the request runs, so a slow dyno looks
//      exactly like a dead button;
//   2. the refresh that follows the write was called without await and without
//      a catch, so a failed refresh after a SUCCESSFUL write was silent — the
//      task existed, the board disagreed, and nothing said which.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };
const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

const SUBMIT = (() => {
  const i = app.indexOf("$('#task-form').addEventListener('submit'");
  return app.slice(i, app.indexOf('\n});', i));
})();

console.log('a second click cannot create a second task');
t('the submit button is DISABLED while the request is in flight', () => {
  // Disabled, not just flagged: the browser refuses the click rather than the
  // handler ignoring it, so it also stops a double submit from the keyboard.
  assert.ok(/btn\.disabled = true/.test(SUBMIT), 'the button is never disabled');
  assert.ok(/btn\.disabled = false/.test(SUBMIT), 'the button is never re-enabled');
});
t('it is re-enabled in finally, so an error does not leave it dead', () => {
  const fin = SUBMIT.slice(SUBMIT.indexOf('} finally {'));
  assert.ok(/btn\.disabled = false/.test(fin), 're-enabling is not in finally');
  assert.ok(/taskAddInFlight = false/.test(fin), 'the flag is not cleared in finally');
});
t('there is a re-entry guard as well as the disabled attribute', () => {
  assert.ok(/if \(taskAddInFlight\) return;/.test(SUBMIT),
    'a programmatic submit could still get through');
});
t('the button says what is happening, not just nothing', () => {
  // The whole cause: several seconds of a live button and an unchanged board.
  assert.ok(/Adding…/.test(SUBMIT), 'the button gives no sign the request is running');
  assert.ok(/btn\.textContent = label/.test(SUBMIT), 'the label is never restored');
});
t('the form markup still has the submit button this depends on', () => {
  const i = html.indexOf('<form id="task-form"');
  const form = html.slice(i, html.indexOf('</form>', i));
  assert.ok(/<button type="submit">/.test(form), 'the handler looks for a button that is gone');
});

console.log('\na failed refresh is never silent');
t('every post-write refresh goes through refreshTasks', () => {
  // An unawaited rejection escapes the surrounding try/catch, which is how a
  // failed refresh produced no message at all.
  const region = app.slice(app.indexOf('async function refreshTasks('),
    app.indexOf("$('#refresh-tasks')"));
  const bare = region.split('\n').filter(l =>
    /(^|[^.\w])loadTasks\(\);/.test(l) && !/await/.test(l) && !/^\s*\/\//.test(l));
  assert.deepStrictEqual(bare, [], `these call loadTasks without await:\n${bare.join('\n')}`);
});
t('refreshTasks awaits and catches', () => {
  const i = app.indexOf('async function refreshTasks(');
  const body = app.slice(i, app.indexOf('\n}', i));
  assert.ok(/await loadTasks\(\)/.test(body), 'it does not await');
  assert.ok(/catch/.test(body), 'it does not catch');
});
t('the message distinguishes a failed write from a failed refresh', () => {
  // "Task added, but the board did not refresh" and "could not add the task"
  // are different instructions to the person reading them.
  const i = app.indexOf('async function refreshTasks(');
  assert.ok(/did not refresh/.test(app.slice(i, i + 500)),
    'a refresh failure reads like the write failed');
  assert.ok(/refreshTasks\('Task added'\)/.test(app), 'the add path does not say what succeeded');
});

console.log('\nnothing else about tasks changed');
t('the write still posts to /api/tasks', () => {
  assert.ok(/api\('\/api\/tasks', \{ method: 'POST'/.test(SUBMIT));
});
t('the form is still reset only after the write succeeds', () => {
  assert.ok(SUBMIT.indexOf('form.reset()') > SUBMIT.indexOf("api('/api/tasks'"),
    'the form clears before the write is confirmed, losing the input on failure');
});

console.log(`\n${pass} passing`);
