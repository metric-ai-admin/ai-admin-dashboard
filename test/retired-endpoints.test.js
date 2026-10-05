// Endpoints retired on 2026-10-05.
//
// POST /api/triage/log-session and POST /api/lyndsay/import had no caller
// anywhere in this codebase, no line in Render's access logs since 2026-09-29
// and nothing in activity_log since 10/02. They answer 410 rather than being
// deleted: something external may still hold the URL, and a forgotten flow
// failing against "not found" looks like a typo, while "retired on this date"
// looks like the fact it is.
//
// What these assertions are really protecting is that retiring did not become
// deleting. Both tables are still read by other routes, and a retirement that
// quietly took the data with it would be a much bigger change than the one
// that was asked for.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const server = read('server.js');
const routes = read('metric-routes.js');
const strip = s => s.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const sCode = strip(server);
const rCode = strip(routes);

const RETIRED = [
  { name: 'POST /api/triage/log-session', src: sCode, marker: "app.post('/api/triage/log-session'" },
  { name: 'POST /api/lyndsay/import', src: rCode, marker: "app.post('/api/lyndsay/import'" },
];

console.log('both answer 410 with a reason');
RETIRED.forEach(r => {
  t(`${r.name} returns 410`, () => {
    const i = r.src.indexOf(r.marker);
    assert.ok(i > 0, r.name + ' is gone entirely — it should answer 410, not 404');
    const body = r.src.slice(i, i + 700);
    assert.ok(/res\.status\(410\)/.test(body), 'it does not answer 410');
    assert.ok(/endpoint retired on 2026-10-05/.test(body), 'the message does not say when');
  });
  t(`${r.name} says where the data went`, () => {
    // "Gone" without "and your data is fine" is the sentence that generates a
    // panicked message on a Friday.
    const i = r.src.indexOf(r.marker);
    const body = r.src.slice(i, i + 900);
    assert.ok(/unaffected/.test(body), 'nothing tells the caller the existing data survives');
  });
  t(`${r.name} does nothing else at all`, () => {
    const i = r.src.indexOf(r.marker);
    const body = r.src.slice(i, i + 700);
    assert.ok(!/\.insert\(|\.upsert\(|\.update\(|\.delete\(/.test(body), 'the retired route still writes');
    assert.ok(!/req\.body/.test(body), 'the retired route still reads the body');
    assert.ok(!/async/.test(body.slice(0, 80)), 'the handler is still async, so it still does work');
  });
});

console.log('\nthe data and everything that reads it survive');
t('triage_sessions is still read', () => {
  assert.ok(/from\('triage_sessions'\)/.test(sCode), 'the table reads went with the route');
  assert.ok(/app\.get\('\/api\/triage\/summary'/.test(sCode), 'the summary route was removed too');
});
t('lyndsay_snapshots is still read, and still writable by the task routes', () => {
  assert.ok(/app\.get\('\/api\/lyndsay\/tasks'/.test(rCode), 'the tasks route went with the import');
  assert.ok(/from\('lyndsay_snapshots'\)\.update\(/.test(rCode),
    'marking a task done no longer writes — the retirement took too much with it');
});

console.log('\nthe orphaned probe is gone');
t('identifyCaller is removed, not left dangling', () => {
  // Both routes were its only users. A helper kept "just in case" is a helper
  // nobody can tell is dead.
  assert.ok(!/function identifyCaller/.test(rCode), 'identifyCaller is still defined');
  assert.ok(!/identifyCaller/.test(sCode), 'server.js still imports or calls it');
  assert.ok(!/identifyCaller[,}]/.test(rCode), 'it is still exported');
});
t('the boot-time assertion it carried went with it', () => {
  // It threw if either guard became async. With the probe gone there is
  // nothing for that to protect, and leaving it would be a trap that fires for
  // a reason nobody can find.
  assert.ok(!/assumes .* is synchronous/.test(routes));
});
t('a note records what it was for', () => {
  // Deleting it without a trace leaves the next person wondering why two
  // routes were once instrumented.
  assert.ok(/identifyCaller lived here until 2026-10-05/.test(routes));
});

console.log('\nActivity Logs treats them as system, not as work');
t('both are system routes', () => {
  const A = require('../lib/activity-actions.js');
  ['/api/triage/log-session', '/api/lyndsay/import'].forEach(p => {
    assert.ok(A.isSystem(p), p + ' would count as somebody working');
    assert.ok(/retired 2026-10-05/.test(A.systemReason(p)), 'the reason is stale');
  });
});
t('neither has a catalogue label any more', () => {
  // A label would describe an action that cannot happen.
  const A = require('../lib/activity-actions.js');
  assert.deepStrictEqual(A.ACTIONS.filter(a => /triage\/log-session|lyndsay\/import/.test(a[1])), []);
});
t('every other write route still has a name', () => {
  // The catalogue test covers this, but removing an entry is exactly when a
  // path gets deleted one line too far.
  const A = require('../lib/activity-actions.js');
  assert.strictEqual(A.describe('POST', '/api/lyndsay/tasks/9/done').label, "Marked Lyndsay's task done");
  assert.strictEqual(A.describe('POST', '/api/tasks').label, 'Created task');
});

console.log(`\n${pass} passing`);
