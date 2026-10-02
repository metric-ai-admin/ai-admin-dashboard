// The activity logger.
//
// Two things must be true no matter what, and both are about the logger NOT
// mattering: it must never slow a request down, and it must never fail one.
// A third is about what it stores: a column that quietly filled with resident
// names would be a different table from the one anybody agreed to.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ACT = require('../lib/activity-log.js');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };
const ta = async (name, fn) => { await fn(); pass++; console.log('  ok  ' + name); };
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const ROW = { user_email: 'a@metricpropertymanagement.com', event: 'write' };
const tick = () => new Promise(r => setImmediate(r));

(async () => {
  console.log('it never blocks and never throws');
  t('log() returns nothing — there is no promise to await', () => {
    const l = ACT.createLogger(async () => {});
    assert.strictEqual(l.log(ROW), undefined);
    l.stop();
  });
  t('log() does not throw when the flush function throws synchronously', () => {
    const l = ACT.createLogger(() => { throw new Error('boom'); }, { maxRows: 1 });
    assert.doesNotThrow(() => l.log(ROW));
    l.stop();
  });
  t('log() survives junk it was never meant to receive', () => {
    const l = ACT.createLogger(async () => {});
    [null, undefined, 'string', 42, [], { }, { event: 'write' }].forEach(bad =>
      assert.doesNotThrow(() => l.log(bad), String(bad)));
    l.stop();
  });
  await ta('a flush that never settles does not stop new rows being accepted', async () => {
    // The batch is taken off the queue BEFORE the write. A hung Supabase call
    // must not make log() start blocking or losing everything behind it.
    let release;
    const l = ACT.createLogger(() => new Promise(r => { release = r; }), { maxRows: 2 });
    l.log(ROW); l.log(ROW);              // triggers a drain that hangs
    await tick();
    l.log(ROW); l.log(ROW);              // must still be accepted
    assert.strictEqual(l.stats().pending, 2, 'new rows were rejected while a flush hung');
    release();
    l.stop();
  });

  console.log('\nthe queue is bounded, and drops rather than growing');
  await ta('a failing flush drops the batch — it is never requeued', async () => {
    let calls = 0;
    const l = ACT.createLogger(async () => { calls++; throw new Error('supabase down'); }, { maxRows: 2 });
    l.log(ROW); l.log(ROW);
    await tick(); await tick();
    const s = l.stats();
    assert.strictEqual(s.pending, 0, 'the failed batch was requeued — the queue will grow without bound');
    assert.strictEqual(s.dropped, 2);
    assert.strictEqual(s.failures, 1);
    assert.strictEqual(calls, 1, 'it retried a failing write');
    l.stop();
  });
  await ta('with Supabase down forever, the queue never exceeds the cap', async () => {
    const l = ACT.createLogger(async () => { throw new Error('down'); }, { maxRows: 10 });
    for (let i = 0; i < 5000; i++) { l.log(ROW); if (i % 50 === 0) await tick(); }
    await tick(); await tick();
    assert.ok(l.stats().pending <= 10, `queue grew to ${l.stats().pending}`);
    l.stop();
  });
  await ta('over the cap it drops the OLDEST, keeping what was just asked about', async () => {
    // Reaching the cap empties the queue into a batch, so overflow only bites
    // once a flush is in flight AND the queue has refilled behind it. That is
    // exactly the Supabase-is-slow case this cap exists for.
    const l = ACT.createLogger(() => new Promise(() => {}), { maxRows: 3 });
    ['a', 'b', 'c'].forEach(r => l.log({ user_email: r, event: 'write' }));  // drains, hangs
    await tick();
    ['d', 'e', 'f'].forEach(r => l.log({ user_email: r, event: 'write' }));  // refills to the cap
    assert.strictEqual(l.stats().dropped, 0, 'it dropped before the queue was actually full');
    l.log({ user_email: 'g', event: 'write' });                              // one too many
    assert.strictEqual(l.stats().dropped, 1, 'the overflow row was not dropped');
    assert.strictEqual(l.stats().pending, 3, 'the cap was exceeded');
    l.stop();
  });
  await ta('the error handler is told, and cannot break the logger either', async () => {
    let told = 0;
    const l = ACT.createLogger(async () => { throw new Error('x'); },
      { maxRows: 1, onError: () => { told++; throw new Error('the handler is broken too'); } });
    assert.doesNotThrow(() => l.log(ROW));
    await tick(); await tick();
    assert.strictEqual(told, 1);
    l.stop();
  });

  console.log('\nwhat it refuses to store');
  t('a row carrying a forbidden field is dropped WHOLE, not trimmed', () => {
    // A half-stored row looks like a good row. Dropping it is the honest
    // failure.
    ['body', 'query', 'notes', 'tenant', 'resident', 'amount', 'rent', 'phone',
      'address', 'password', 'token', 'authorization', 'subject',
    ].forEach(f => {
      const r = Object.assign({}, ROW); r[f] = 'anything';
      assert.strictEqual(ACT.clean(r), null, `${f} was not rejected`);
    });
  });
  t('the three identity fields are kept — they are the point', () => {
    const c = ACT.clean({ user_email: 'x@y.com', user_name: 'Katie', user_role: 'leasing_bd', event: 'login' });
    assert.strictEqual(c.user_name, 'Katie');
    assert.strictEqual(c.user_role, 'leasing_bd');
  });
  t('unknown keys are discarded rather than stored', () => {
    const c = ACT.clean(Object.assign({ whatever: 'x', ip: '1.2.3.4', user_agent: 'curl' }, ROW));
    assert.deepStrictEqual(Object.keys(c).sort(), ['event', 'user_email']);
  });
  t('a row with no identity or no event is dropped', () => {
    assert.strictEqual(ACT.clean({ event: 'write' }), null);
    assert.strictEqual(ACT.clean({ user_email: 'x@y.com' }), null);
  });
  t('strings are capped so one long value cannot bloat the table', () => {
    const c = ACT.clean({ user_email: 'x@y.com', event: 'write', resource: 'z'.repeat(5000) });
    assert.ok(c.resource.length <= 300);
  });

  console.log('\nwhat it derives from a route');
  t('the section is the first segment after /api/', () => {
    assert.strictEqual(ACT.sectionOf('/api/tasks/123'), 'tasks');
    assert.strictEqual(ACT.sectionOf('/api/marketing/Ascent%20at%20Northgate'), 'marketing');
    assert.strictEqual(ACT.sectionOf('/api/leasing/sync/occupancy'), 'leasing');
    assert.strictEqual(ACT.sectionOf('/health'), null);
  });
  t('a query string never reaches the section or the resource', () => {
    // This is where a resident name would arrive if it arrived anywhere.
    assert.strictEqual(ACT.sectionOf('/api/tasks?tenant=Maria+Petit'), 'tasks');
    assert.strictEqual(ACT.resourceOf('/api/tasks?tenant=Maria+Petit'), null);
    assert.ok(!String(ACT.resourceOf('/api/tasks/55?q=Maria')).includes('Maria'));
  });
  t('only id-shaped segments are kept as the resource', () => {
    assert.strictEqual(ACT.resourceOf('/api/tasks/task_1790352153592_8968'), 'task_1790352153592_8968');
    assert.strictEqual(ACT.resourceOf('/api/kpi-recaps/0b9ef11f-a105-11f1-9ece-0269bfa09cb1'), '0b9ef11f-a105-11f1-9ece-0269bfa09cb1');
    // A name is not an id, and a name can be a person.
    assert.strictEqual(ACT.resourceOf('/api/marketing/Ascent at Northgate'), null);
    assert.strictEqual(ACT.resourceOf('/api/leasing/sync/occupancy'), null);
  });
  t('the 30-minute view bucket rounds down, both halves of the hour', () => {
    assert.strictEqual(ACT.viewBucket('2026-10-02T14:07:33Z'), '2026-10-02T14:00:00.000Z');
    assert.strictEqual(ACT.viewBucket('2026-10-02T14:29:59Z'), '2026-10-02T14:00:00.000Z');
    assert.strictEqual(ACT.viewBucket('2026-10-02T14:30:00Z'), '2026-10-02T14:30:00.000Z');
    assert.strictEqual(ACT.viewBucket('nonsense'), null);
  });

  console.log('\nhow it is wired into the server');
  t('writes are recorded after the response, not during it', () => {
    const i = server.indexOf('function activityWriteLogger(');
    const body = server.slice(i, i + 1400);
    assert.ok(/res\.on\('finish'/.test(body),
      'the row is written inside the request, which puts logging in the user path');
    assert.ok(/^\s*next\(\);/m.test(body), 'the middleware does not call next()');
    assert.ok(!/await activityLog/.test(server), 'somewhere awaits the logger');
  });
  t('identity comes off the verified JWT, never off a header or the body', () => {
    const i = server.indexOf('function activityActor(');
    const body = server.slice(i, i + 400);
    assert.ok(/req\.user/.test(body));
    assert.ok(!/req\.(headers|body|query)/.test(body), 'identity is taken from caller-controlled input');
  });
  t('a request with no session records nothing', () => {
    // An API-key call is not a person, and inventing one would be worse than
    // the gap.
    const i = server.indexOf('function activityActor(');
    assert.ok(/if \(!u \|\| !u\.email\) return null;/.test(server.slice(i, i + 400)));
  });
  t('login and logout are both recorded, logout before the cookie is cleared', () => {
    const lo = server.indexOf("app.post('/api/auth/logout'");
    const body = server.slice(lo, lo + 800);
    assert.ok(body.indexOf("event: 'logout'") < body.indexOf('res.clearCookie'),
      'the cookie is cleared before the identity is read, so logout records nobody');
    assert.ok(/event: 'login'/.test(server), 'login is not recorded');
  });
  t('a bad token on logout does not turn a logout into an error', () => {
    const lo = server.indexOf("app.post('/api/auth/logout'");
    assert.ok(/catch \{[^}]*\}/.test(server.slice(lo, lo + 800)), 'jwt.verify is unguarded');
  });
  t('retention sweeps 90 days in the nightly cron, independent of SimpleVOIP', () => {
    const i = server.indexOf("cron.schedule('0 2 * * *'");
    const body = server.slice(i, i + 900);
    assert.ok(/90 \* 86400000/.test(body), 'the retention window is not 90 days');
    assert.ok(body.indexOf('activity_log') < body.indexOf('simplevoip.isConfigured()'),
      'the sweep sits behind the SimpleVOIP guard and would never run without it');
  });

  console.log('\nnothing user-facing yet');
  t('no tab, no route, no browser code reads it — phases 2 and 3 are next week', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    assert.ok(!/activity[_-]log/i.test(app + html), 'the browser now references the activity log');
    assert.ok(!/app\.get\('\/api\/activity/.test(server), 'a read route was added');
  });

  console.log(`\n${pass} passing`);
})().catch(e => { console.error(e); process.exit(1); });
