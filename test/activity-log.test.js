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
    // Sliced to the END OF THE FUNCTION, not to a byte count. A fixed window
    // stops covering what it was written for as soon as a line is added above
    // its target — which is exactly what happened when property_name went in.
    const i = server.indexOf('function activityWriteLogger(');
    const end = server.indexOf('// ---- Auth helpers', i);
    assert.ok(i > 0 && end > i, 'activityWriteLogger or its end marker moved');
    const body = server.slice(i, end);
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

  console.log('\nthe guards attribute a session to a person');
  // THE BUG THIS BLOCK EXISTS FOR. requireMetricAccess validated the session
  // and threw the payload away, so req.user was undefined on all 133 routes
  // behind it and every write through them logged nobody. Two task writes by a
  // signed-in admin on 2026-10-02 produced no row at all.
  const MR = fs.readFileSync(path.join(__dirname, '..', 'metric-routes.js'), 'utf8');
  const ATTACH = MR.slice(MR.indexOf('function attachSessionUser('),
    MR.indexOf('function requireMetricAccess('));
  const attachWith = payload => new Function('sessionPayload', ATTACH + 'return attachSessionUser;')(() => payload);
  const guard = name => {
    const i = MR.indexOf('function ' + name + '(');
    return MR.slice(i, MR.indexOf('\n}', i));
  };

  t('requireMetricAccess puts the signed-in person on the request', () => {
    const g = guard('requireMetricAccess');
    assert.ok(/attachSessionUser\(req\)/.test(g),
      'the guard still validates the session and discards who it was');
    assert.ok(!/hasValidSession\(req\)\) return next\(\)/.test(g),
      'it still authorises off a boolean that carries no identity');
  });
  t('requireMetricAdmin does too', () => {
    assert.ok(/attachSessionUser\(req\)/.test(guard('requireMetricAdmin')));
  });
  t('a key-only call still has no person', () => {
    // attachSessionUser reads the cookie. No cookie, no person — which is what
    // keeps an API-key write unattributed instead of attributed to whoever.
    const req = { get: () => 'the-key' };
    assert.strictEqual(attachWith(null)(req), null);
    assert.strictEqual(req.user, undefined, 'a key-only request was given a person');
  });
  t('a session is attached whichever branch authorises', () => {
    const payload = { email: 'a@b.com', name: 'A', role: 'admin' };
    const req = {};
    assert.deepStrictEqual(attachWith(payload)(req), payload);
    assert.deepStrictEqual(req.user, payload);
  });
  t('it never overwrites what requireAuth already set', () => {
    const mine = { email: 'real@b.com' };
    const req = { user: mine };
    attachWith({ email: 'other@b.com' })(req);
    assert.strictEqual(req.user, mine);
  });
  t('a session write to /api/tasks produces a row with section "tasks"', () => {
    // End to end on the shapes rather than the network: the guard attaches the
    // user, the middleware reads it, the row names the section and the id.
    const rows = [];
    const l = ACT.createLogger(async r => { rows.push(...r); });
    const req = {
      method: 'POST', path: '/api/tasks/task_1790950441037_9749/done',
      user: { email: 'arturo@metric.internal', name: 'Arturo', role: 'admin' },
    };
    l.log({
      user_email: req.user.email, user_name: req.user.name, user_role: req.user.role,
      event: 'write', section: ACT.sectionOf(req.path), resource: ACT.resourceOf(req.path),
      method: req.method, status_code: 200,
    });
    l.flushNow();
    assert.strictEqual(rows.length, 1, 'the write produced no row');
    assert.strictEqual(rows[0].section, 'tasks');
    assert.strictEqual(rows[0].resource, 'task_1790950441037_9749');
    assert.strictEqual(rows[0].user_email, 'arturo@metric.internal');
    assert.ok(!JSON.stringify(rows[0]).toLowerCase().includes('activity logs test'),
      'a task title reached the row');
    l.stop();
  });

  console.log('\nwhat phase 1 guarded, now that 2 and 3 exist');
  // This used to assert that NOTHING user-facing existed — "phases 2 and 3 are
  // next week". Phase 3 made that false on purpose, so the assertion is
  // replaced rather than deleted: what it was really protecting is that the
  // log is not readable by whoever happens to find the URL.
  //
  // Worth recording that it did not catch phase 2. It tested
  // app.get('/api/activity…) and the beacon is a POST, so the write path went
  // in without tripping a test whose stated purpose was "no route yet". A
  // guard narrower than its own description is a guard that will be believed
  // when it should not be.
  t('every READ route is behind admin/ceo', () => {
    // Captures what follows the path up to the handler, not up to the first
    // ")" — that one lives inside requireRole(...) and cut the guard in half.
    const gets = [...server.matchAll(/app\.get\('(\/api\/activity[^']*)',([\s\S]*?)(?:async )?\(req, res\)/g)];
    assert.ok(gets.length >= 2, 'the read routes vanished');
    gets.forEach(m => {
      assert.ok(/requireAuth,\s*requireRole\(\.\.\.ACTIVITY_ROLES\)/.test(m[2]),
        m[1] + ' is not behind the role guard — middleware seen: ' + m[2].trim());
    });
  });
  t('the WRITE route stays open to any signed-in user', () => {
    // Everybody's sections are recorded; only reading is restricted.
    assert.ok(/app\.post\('\/api\/activity\/view', requireAuth, \(req, res\)/.test(server));
  });
  t('the browser never reads the raw table', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    assert.ok(!/from\('activity_log'\)/.test(app),
      'the browser queries the table directly instead of going through a gated route');
  });

  console.log(`\n${pass} passing`);
})().catch(e => { console.error(e); process.exit(1); });
