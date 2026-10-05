// Activity Logs phase 2 — section views.
//
// The rules are phase 1's: it never blocks navigation, the queue is bounded,
// nothing can throw into a route, and an API-key call is not a person. What is
// new is that the SECTION now comes from the browser, which is the first value
// in this table a user could choose.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ACT = require('../lib/activity-log.js');

let pass = 0;
// An async test whose promise nobody awaits can never fail — it resolves after
// the process has already printed its total. Async bodies are collected and
// awaited at the end instead.
const pending = [];
const t = (name, fn) => {
  const r = fn();
  if (r && typeof r.then === 'function') {
    pending.push(r.then(
      () => { pass++; console.log('  ok  ' + name); },
      err => { console.error('  FAIL  ' + name); throw err; }));
    return;
  }
  pass++; console.log('  ok  ' + name);
};
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
// Assertions match code, never the comments around it.
const code = server.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const appCode = app.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

console.log('the 30-minute bucket');
t('everything inside one half hour lands in the same bucket', () => {
  const b = ACT.viewBucket('2026-10-05T14:00:00Z');
  ['2026-10-05T14:00:00Z', '2026-10-05T14:01:30Z', '2026-10-05T14:29:59Z']
    .forEach(s => assert.strictEqual(ACT.viewBucket(s), b, s + ' fell in a different bucket'));
  assert.strictEqual(b, '2026-10-05T14:00:00.000Z');
});
t('the half hour boundary starts a new bucket', () => {
  assert.notStrictEqual(ACT.viewBucket('2026-10-05T14:29:59Z'), ACT.viewBucket('2026-10-05T14:30:00Z'));
  assert.strictEqual(ACT.viewBucket('2026-10-05T14:30:00Z'), '2026-10-05T14:30:00.000Z');
  assert.strictEqual(ACT.viewBucket('2026-10-05T14:59:59Z'), '2026-10-05T14:30:00.000Z');
});
t('an unparseable time buckets to null rather than to now', () => {
  // Falling back to the current time would write a row that claims a visit
  // happened when it did not, and would defeat the unique index as well.
  assert.strictEqual(ACT.viewBucket('not a date'), null);
  assert.strictEqual(ACT.viewBucket(undefined), null);
});
t('the uniqueness is the index, and it is partial', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations',
    '073_activity_log.sql'), 'utf8');
  assert.ok(/create unique index if not exists activity_log_view_uniq/.test(sql));
  assert.ok(/on activity_log \(user_email, section, view_bucket\)/.test(sql));
  assert.ok(/where event = 'view'/.test(sql),
    'the index is not partial, so writes and logins would collide with each other');
});

console.log('\nthe section name cannot carry content');
t('ordinary tab names pass', () => {
  ['leasing', 'crm', 'bd_crm', 'work-orders', 'Marketing', '  tasks  ']
    .forEach(s => assert.ok(ACT.normalizeSection(s), JSON.stringify(s) + ' was rejected'));
  assert.strictEqual(ACT.normalizeSection('Marketing'), 'marketing');
  assert.strictEqual(ACT.normalizeSection('  tasks  '), 'tasks');
});
t('anything that could be a person is rejected WHOLE', () => {
  // Stripping the offending characters would leave the letters of a name
  // behind, which is still a leak. The value is dropped instead.
  ['Mendoza, Simon', 'a@b.com', '(737) 881-7336', '9315 Northgate Blvd',
    'leasing; drop table', '<script>', 'x'.repeat(41),
  ].forEach(s => assert.strictEqual(ACT.normalizeSection(s), null, JSON.stringify(s) + ' was accepted'));
});
t('empty and missing are null, not empty strings', () => {
  [null, undefined, '', '   '].forEach(s => assert.strictEqual(ACT.normalizeSection(s), null));
});
t('the route drops a bad section instead of storing it', () => {
  const i = code.indexOf("app.post('/api/activity/view'");
  const body = code.slice(i, i + 700);
  assert.ok(/const section = ACT\.normalizeSection\(req\.body && req\.body\.section\);/.test(body),
    'the section is taken from the body unsanitised');
  assert.ok(/if \(!section\) return;/.test(body), 'an unparseable section is still written');
});
t('nothing but the section is read off the body', () => {
  const i = code.indexOf("app.post('/api/activity/view'");
  const body = code.slice(i, i + 700);
  // Every property actually read off the body. A bare `req.body &&` guard is
  // not a read and is not matched.
  const bodyReads = body.match(/req\.body[.[][A-Za-z_'"\]]+/g) || [];
  assert.deepStrictEqual([...new Set(bodyReads)], ['req.body.section'],
    'the route reads more of the body than the section: ' + bodyReads.join(', '));
});

console.log('\nit cannot break navigation');
t('the response goes out before anything is logged', () => {
  const i = code.indexOf("app.post('/api/activity/view'");
  const body = code.slice(i, i + 700);
  assert.ok(body.indexOf('res.status(204).end()') < body.indexOf('activityLog.log('),
    'the browser waits for the log write');
});
t('the handler is wrapped so nothing reaches the caller', () => {
  const i = code.indexOf("app.post('/api/activity/view'");
  const body = code.slice(i, i + 700);
  assert.ok(/try \{/.test(body) && /\} catch \{/.test(body));
});
t('the client sends and forgets', () => {
  assert.ok(/function logSectionView/.test(appCode), 'there is no beacon');
  const i = appCode.indexOf('function logSectionView');
  const body = appCode.slice(i, appCode.indexOf('function loadTab', i));
  assert.ok(/\.catch\(\(\) => \{\}\)/.test(body), 'a failed beacon surfaces to the user');
  assert.ok(!/await /.test(body), 'navigation waits for the beacon');
  assert.ok(/keepalive: true/.test(body), 'the last section of a session is lost on close');
  assert.ok(/try \{/.test(body) && /\} catch \{/.test(body), 'a throw would reach loadTab');
});
t('the client validates the section too, before sending', () => {
  const i = appCode.indexOf('function logSectionView');
  const body = appCode.slice(i, appCode.indexOf('function loadTab', i));
  assert.ok(/\^\[a-z0-9_-\]\{1,40\}\$/.test(body), 'the browser sends whatever it is given');
});
t('it fires from loadTab, the one funnel every section change goes through', () => {
  assert.ok(/function loadTab\(tab\) \{\s*\n\s*logSectionView\(tab\);/.test(appCode),
    'the beacon hangs off the click handler and misses programmatic switches');
});

console.log('\nit is a person, not an API key');
t('the route requires a session', () => {
  assert.ok(/app\.post\('\/api\/activity\/view', requireAuth,/.test(code),
    'an API key could write view rows');
  assert.ok(!/app\.post\('\/api\/activity\/view', requireMetricAccess/.test(code));
});
t('identity comes off the JWT, never the body', () => {
  const i = code.indexOf("app.post('/api/activity/view'");
  const body = code.slice(i, i + 700);
  assert.ok(/const who = activityActor\(req\);/.test(body));
  assert.ok(/if \(!who\) return;/.test(body), 'a request with no session still logs');
});

console.log('\na duplicate view does not destroy the batch');
t('a 23505 is retried per row rather than thrown', () => {
  // Views and writes share one queue. A rejected duplicate is the NORMAL case
  // for views, and a single 23505 fails the whole insert — one person clicking
  // back into Leasing would discard everybody's write rows in that flush.
  const i = code.indexOf('const activityLog = ACT.createLogger');
  const body = code.slice(i, code.indexOf('function activityActor'));
  assert.ok(/error\.code !== '23505'/.test(body), 'a duplicate still throws');
  assert.ok(/for \(const row of rows\)/.test(body), 'there is no per-row retry');
  assert.ok(/continue;/.test(body), 'the conflicting row is not skipped');
});
t('a real error still fails, so it is not swallowed', () => {
  const i = code.indexOf('const activityLog = ACT.createLogger');
  const body = code.slice(i, code.indexOf('function activityActor'));
  assert.ok(/throw new Error\(error\.message\);/.test(body), 'every error is treated as a duplicate');
  assert.ok(/row\(s\) failed individually/.test(body), 'a per-row failure is silent');
});

console.log('\nthe beacon is not also logged as a write');
t('the view route is registered before the write middleware', () => {
  // Express runs middleware in mount order. Reversed, every beacon would write
  // two rows: the view it means and a 'write' to /api/activity that means
  // nothing.
  const route = code.indexOf("app.post('/api/activity/view'");
  const mw = code.indexOf("app.use('/api', activityWriteLogger)");
  assert.ok(route > 0 && mw > 0, 'one of the two moved');
  assert.ok(route < mw, 'the beacon is now double-logged as a write');
});

console.log('\nthe phase 1 guarantees still hold');
t('view is an allowed event and view_bucket an allowed column', () => {
  assert.ok(ACT.ALLOWED.indexOf('view_bucket') !== -1, 'the bucket would be stripped before insert');
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations',
    '073_activity_log.sql'), 'utf8');
  assert.ok(/check \(event in \('login', 'logout', 'view', 'write'\)\)/.test(sql));
});
t('a view row carrying a forbidden field is dropped whole', async () => {
  const logged = [];
  const lg = ACT.createLogger(async rows => { logged.push(...rows); },
    { setInterval: () => 0 });
  lg.log({ user_email: 'a@b.com', event: 'view', section: 'leasing', resident: 'Mendoza, Simon' });
  lg.log({ user_email: 'a@b.com', event: 'view', section: 'leasing' });
  assert.strictEqual(lg.stats().pending, 1, 'the row with a forbidden field was queued');
  await lg.flushNow();
  assert.strictEqual(logged.length, 1);
  assert.strictEqual(logged[0].resident, undefined);
});
t('a view row keeps only the allowed columns', async () => {
  const logged = [];
  const lg = ACT.createLogger(async rows => { logged.push(...rows); }, { setInterval: () => 0 });
  lg.log({ user_email: 'a@b.com', event: 'view', section: 'leasing',
    view_bucket: '2026-10-05T14:00:00.000Z', nonsense: 'x' });
  await lg.flushNow();
  const row = logged[0];
  assert.ok(row, 'the row was dropped');
  assert.strictEqual(row.nonsense, undefined, 'an unknown field reached the row');
  assert.strictEqual(row.view_bucket, '2026-10-05T14:00:00.000Z');
  assert.strictEqual(row.section, 'leasing');
});

Promise.all(pending).then(() => {
  console.log(`\n${pass} passing`);
}, err => {
  console.error(err);
  process.exit(1);
});
