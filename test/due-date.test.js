// Due dates: what the API accepts, what it refuses, and how a card reads.
//
// due_on has been a field on tasks for a long time and both /api/tasks routes
// already accepted it — but neither checked it. "next friday", "10/03/2026"
// and "2026-13-45" all went into tasks.json and on to Asana, which drops an
// unparseable date without a word. The task ended up with a due date here and
// none there, and nothing said so.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const D = require('../lib/due-date.js');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

console.log('what counts as a date');
t('a real YYYY-MM-DD is accepted', () => {
  ['2026-10-03', '2026-01-01', '2026-12-31', '2028-02-29'].forEach(v =>
    assert.strictEqual(D.isValidDueOn(v), true, v));
});
t('a date that does not exist is refused, not rolled forward', () => {
  // Date turns these into March and 2027 rather than complaining, which is why
  // the check formats the result and compares instead of trusting the parse.
  ['2026-02-30', '2026-13-45', '2026-11-31', '2026-02-29'].forEach(v =>
    assert.strictEqual(D.isValidDueOn(v), false, v));
});
t('anything that is not the format is refused', () => {
  ['next friday', 'tomorrow', '10/03/2026', '2026-10-3', '03-10-2026',
   '2026-10-03T00:00:00Z', '', null, undefined, 20261003, {},
  ].forEach(v => assert.strictEqual(D.isValidDueOn(v), false, String(v)));
});

console.log('\nabsent is not the same as cleared');
t('omitting due_on leaves the existing date alone', () => {
  // The MCP edit tool sends a partial patch on every call. Conflating these
  // two would wipe a date whenever someone changed a title.
  assert.deepStrictEqual(D.parseDueOn(undefined), { ok: true, value: undefined });
});
t('null or empty clears it', () => {
  assert.deepStrictEqual(D.parseDueOn(null), { ok: true, value: null });
  assert.deepStrictEqual(D.parseDueOn(''), { ok: true, value: null });
  assert.deepStrictEqual(D.parseDueOn('   '), { ok: true, value: null });
});
t('a date is kept, trimmed', () => {
  assert.deepStrictEqual(D.parseDueOn('2026-10-03'), { ok: true, value: '2026-10-03' });
  assert.deepStrictEqual(D.parseDueOn(' 2026-10-03 '), { ok: true, value: '2026-10-03' });
});
t('a bad date is an error that names what it got', () => {
  const r = D.parseDueOn('next friday');
  assert.strictEqual(r.ok, false);
  assert.ok(/YYYY-MM-DD/.test(r.error), 'the error does not say the expected format');
  assert.ok(/next friday/.test(r.error), 'the error does not quote what was sent');
});

console.log('\nhow a card reads');
t('before today is overdue', () => {
  assert.strictEqual(D.dueState('2026-09-29', '2026-09-30', false), 'overdue');
  assert.strictEqual(D.dueState('2025-01-01', '2026-09-30', false), 'overdue');
});
t('today and tomorrow are both soon', () => {
  // Tomorrow counts because the colour means "before you close the laptop".
  assert.strictEqual(D.dueState('2026-09-30', '2026-09-30', false), 'soon');
  assert.strictEqual(D.dueState('2026-10-01', '2026-09-30', false), 'soon');
});
t('the day after tomorrow is not', () => {
  assert.strictEqual(D.dueState('2026-10-02', '2026-09-30', false), 'none');
});
t('tomorrow works across a month and a year boundary', () => {
  assert.strictEqual(D.dueState('2026-10-01', '2026-09-30', false), 'soon');
  assert.strictEqual(D.dueState('2027-01-01', '2026-12-31', false), 'soon');
});
t('a completed task is never late', () => {
  // Colouring it would be scolding someone for work already done.
  assert.strictEqual(D.dueState('2020-01-01', '2026-09-30', true), 'none');
  assert.strictEqual(D.dueState('2026-09-30', '2026-09-30', true), 'none');
});
t('no date, or a broken one, colours nothing', () => {
  [null, undefined, '', 'next friday', '2026-13-45'].forEach(v =>
    assert.strictEqual(D.dueState(v, '2026-09-30', false), 'none', String(v)));
});

console.log('\nthe routes refuse a bad date instead of storing it');
const server = read('server.js');
t('POST validates before it builds the task', () => {
  const i = server.indexOf("app.post('/api/tasks', requireMetricAccess");
  const body = server.slice(i, i + 1400);
  assert.ok(/DUE\.parseDueOn\(due_on\)/.test(body), 'POST does not validate due_on');
  assert.ok(/res\.status\(400\)\.json\(\{ error: due\.error \}\)/.test(body), 'POST does not answer 400');
  assert.ok(body.indexOf('DUE.parseDueOn') < body.indexOf('const task = {'),
    'POST validates after building the task, so a bad date is half-applied');
});
t('PUT validates before it writes anything', () => {
  const i = server.indexOf("app.put('/api/tasks/:id'");
  const body = server.slice(i, i + 1600);
  assert.ok(/DUE\.parseDueOn/.test(body), 'PUT does not validate due_on');
  assert.ok(body.indexOf('DUE.parseDueOn') < body.indexOf('for (const k of allowed)'),
    'PUT writes the other fields before checking the date, so a rejection leaves a half-edit');
  assert.ok(/due\.value !== undefined/.test(body),
    'PUT does not distinguish "not supplied" from "cleared" — a partial patch would wipe the date');
  assert.ok(!/'due_on'\]/.test(body.slice(0, body.indexOf('for (const k of allowed)'))),
    'due_on is still in the blind copy loop, which would bypass the validator');
});

console.log('\nthe MCP tools can set it');
const mcp = read('mcp-tools.cjs');
t('add_operational_task takes due_on', () => {
  const i = mcp.indexOf("registerTool('add_operational_task'");
  const body = mcp.slice(i, i + 1600);
  assert.ok(/due_on: z\.string\(\)\.optional\(\)/.test(body), 'add has no due_on');
  assert.ok(/YYYY-MM-DD/.test(body), 'the description does not tell the model the format');
});
t('update_operational_task takes due_on, and null to clear it', () => {
  const i = mcp.indexOf("registerTool('update_operational_task'");
  const body = mcp.slice(i, i + 1800);
  assert.ok(/due_on: z\.string\(\)\.nullable\(\)\.optional\(\)/.test(body),
    'update cannot clear a due date');
  assert.ok(/omit it to leave the current one unchanged/.test(body),
    'the description does not distinguish omitting from clearing');
});

console.log('\nAsana gets the same date');
t('create sends due_on', () => {
  const i = server.indexOf('async function asanaSyncCreate(');
  assert.ok(/data\.due_on = task\.due_on/.test(server.slice(i, i + 700)), 'the Asana card is created without the date');
});
t('an edit pushes the change, including a clear', () => {
  const i = server.indexOf("app.put('/api/tasks/:id'");
  const body = server.slice(i, i + 3000);
  assert.ok(/fields\.due_on = t\.due_on \|\| null/.test(body),
    'a due date change is not mirrored to Asana');
  assert.ok(/\(t\.due_on \|\| null\) !== before\.due_on/.test(body),
    'it pushes due_on on every edit rather than only when it changed');
});

console.log('\nthe card uses the shared rule, not its own');
t('app.js asks the module', () => {
  const app = read('public/app.js');
  assert.ok(/MetricDue\.dueState\(t\.due_on, today, isDone\)/.test(app),
    'the card decides the colour itself again');
  assert.ok(!/t\.due_on === today/.test(app),
    'the old today-only comparison is back, so tomorrow is not amber');
});
t('the browser is served the module before app.js runs', () => {
  const html = read('public/index.html');
  const due = html.indexOf('/lib/due-date.js');
  const app = html.indexOf('src="app.js"');
  assert.ok(due >= 0, 'index.html does not load /lib/due-date.js');
  assert.ok(due < app, 'it loads after app.js, so MetricDue is undefined when a card renders');
});
t('it is cache-busted like the rest', () => {
  const stamped = /const STAMPED = (\/.*\/[a-z]*);/.exec(server);
  assert.ok(stamped, 'STAMPED is gone — update this test');
  // eslint-disable-next-line no-eval
  const re = eval(stamped[1]);
  assert.ok(re.test('<script src="/lib/due-date.js"></script>'),
    'due-date.js is not cache-busted, so a deploy leaves a stale copy running');
});

console.log('\nthe backfill only fills gaps');
t('it never overwrites a date that is already here', () => {
  const s = read('scripts/backfill-due-dates.js');
  assert.ok(/!t\.due_on/.test(s), 'it would overwrite dates set in the dashboard');
  assert.ok(/--write/.test(s) && /DRY RUN/.test(s), 'it has no dry run');
  assert.ok(/backup/i.test(s), 'it does not back tasks.json up first');
  assert.ok(!/method: 'P(UT|OST)'/.test(s) && !/method: 'PATCH'/.test(s),
    'the backfill writes to Asana — it is supposed to be read-only there');
});

console.log(`\n${pass} passing`);
