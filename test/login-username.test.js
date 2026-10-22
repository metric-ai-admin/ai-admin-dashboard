// What somebody typed into the Username box.
//
// Four leasing agents were given accounts on 2026-10-21 and reported they
// could not sign in. The accounts were fine — confirmed, unbanned, with their
// dashboard_users rows — and one of the four had signed in and changed her
// password the same day, so the flow worked.
//
// The box says "Username" and their address is sammy@metric.internal. Typing
// that built sammy@metric.internal@metric.internal, Supabase rejected it, and
// the screen said "Invalid username or password" — which reads as a wrong
// password and sends somebody to look in the wrong place.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const L = require('../lib/login-username.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const server = read('server.js');

console.log('login username');

// ---- 1. the full email works ---------------------------------------------------

t('the full Metric email is accepted as a username', () => {
  const p = L.parseLogin('sammy@metric.internal');
  assert.strictEqual(p.username, 'sammy');
  assert.strictEqual(p.typedFullEmail, true);
});

t('the domain is not pasted on twice', () => {
  // The bug, stated as the thing it produced.
  assert.notStrictEqual(L.parseLogin('sammy@metric.internal').username + '@metric.internal',
    'sammy@metric.internal@metric.internal');
  assert.strictEqual(L.parseLogin('sammy@metric.internal').username + '@metric.internal',
    'sammy@metric.internal');
});

t('a plain username still works', () => {
  const p = L.parseLogin('sammy');
  assert.strictEqual(p.username, 'sammy');
  assert.strictEqual(p.typedFullEmail, false);
});

t('case and trailing spaces are handled', () => {
  ['  sammy  ', 'Sammy', 'SAMMY', ' SAMMY@METRIC.INTERNAL '].forEach(v => {
    assert.strictEqual(L.parseLogin(v).username, 'sammy', JSON.stringify(v));
  });
});

t('a username with a dot is not truncated', () => {
  // sammy.ramos was the name these accounts nearly got.
  assert.strictEqual(L.parseLogin('sammy.ramos').username, 'sammy.ramos');
  assert.strictEqual(L.parseLogin('sammy.ramos@metric.internal').username, 'sammy.ramos');
});

// ---- 2. a different mistake gets a different answer -------------------------------

t('another domain is refused, not silently accepted', () => {
  // Somebody typing their real work address is not making the same mistake,
  // and signing them in as "arturo" would be a guess at what they meant.
  const p = L.parseLogin('arturo@metricpropertymanagement.com');
  assert.strictEqual(p.typedOtherDomain, 'metricpropertymanagement.com');
  assert.strictEqual(p.typedFullEmail, false);
  assert.match(L.loginHint('arturo@metricpropertymanagement.com'), /not an email address/);
});

t('the hint is silent when there is nothing to hint at', () => {
  assert.strictEqual(L.loginHint('sammy'), null);
  assert.strictEqual(L.loginHint('sammy@metric.internal'), null,
    'it nags about an address that now works');
});

t('the route answers the hint instead of blaming the password', () => {
  const at = server.indexOf("app.post('/api/auth/login'");
  const body = server.slice(at, server.indexOf("app.post('/api/auth/logout'", at));
  assert.match(body, /LOGIN\.parseLogin\(username\)/);
  assert.match(body, /parsed\.typedOtherDomain/);
  assert.match(body, /LOGIN\.loginHint\(username\)/);
  // And the domain is built from the PARSED username, not the raw input.
  assert.match(body, /\$\{parsed\.username\}@metric\.internal/);
  assert.ok(!/\$\{username\.toLowerCase\(\)\.trim\(\)\}@metric\.internal/.test(body),
    'the raw input is still being pasted onto the domain');
});

// ---- 3. a failed sign-in leaves a trace ---------------------------------------------

t('every failure path is recorded', () => {
  // "Did Sammy, Oscar and Yeni even try?" had no answer: the log held only the
  // people who HAD got in. The absence of a failure is not evidence that
  // nobody tried.
  const at = server.indexOf("app.post('/api/auth/login'");
  const body = server.slice(at, server.indexOf("app.post('/api/auth/logout'", at));
  ['wrong credentials', 'no dashboard_users row', 'account inactive']
    .forEach(r => assert.ok(body.includes(r), 'no record for: ' + r));
  assert.match(body, /logLoginFailure\(req, parsed\.username/);
});

t('the password is never written', () => {
  const fn = server.slice(server.indexOf('function logLoginFailure'),
    server.indexOf("app.post('/api/auth/login'"));
  // CODE, NOT COMMENTS. The comment inside this function explains why `detail`
  // is not used and says "the two password routes" — a bare /password/ matched
  // the explanation and reported a leak that was not there.
  const code = fn.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!/(^|[^_a-z])password([^_a-z]|$)/.test(code), 'the password reaches the log');
  assert.match(fn, /event: 'login_failed'/);
  // The reason goes in `action` — activity_log has no `detail` column, and the
  // allowlist in lib/activity-log.js drops any key the table does not have.
  assert.match(fn, /action: 'Sign-in FAILED — ' \+ reason/);
  // Also code-only: the comment names `detail:` to explain why it is absent.
  assert.ok(!/detail:/.test(code), 'it writes to a column that does not exist');
});

t('a log that cannot be written does not block the sign-in page', () => {
  const fn = server.slice(server.indexOf('function logLoginFailure'),
    server.indexOf("app.post('/api/auth/login'"));
  assert.match(fn, /catch \(e\)/);
  assert.ok(!/throw/.test(fn));
});

t('detail is not an activity_log column, anywhere', () => {
  // Found while writing this: the two password routes have passed `detail:`
  // since they were written and it has been discarded every time. They are not
  // changed here — the finding is recorded so it is not re-discovered.
  const allowed = read('lib/activity-log.js');
  const list = allowed.slice(allowed.indexOf('var ALLOWED = ['),
    allowed.indexOf('];', allowed.indexOf('var ALLOWED = [')));
  assert.ok(!/'detail'/.test(list), 'detail IS allowed now — this test is stale');
  assert.ok(/'action'/.test(list), 'action is not allowed either');
});

// ---- 4. the roster matches the accounts ----------------------------------------------

t('the roster uses the short login, which is what exists', () => {
  // The daily check matches a post to a person by login. With the long form
  // all four would have posted and been reported MISSING — the roster names
  // them, so they would have shown as absent rather than simply uncounted.
  const script = read('scripts/load-social-roster.js');
  ['sammy@metric.internal', 'oscar@metric.internal',
    'yeni@metric.internal', 'daria@metric.internal']
    .forEach(e => assert.ok(script.includes("'" + e + "'"), 'missing ' + e));
  ['sammy.ramos@', 'oscar.moreno@', 'yeni.aleman@', 'daria.rodriguez@']
    .forEach(e => assert.ok(!script.includes("'" + e + "metric.internal'"),
      'the long form is still there: ' + e));
});

t('nowhere else carries the long form', () => {
  ['public/index.html', 'server.js', 'lib/fas-deposits.js', 'lib/social-links.js']
    .forEach(f => {
      const src = read(f);
      ['sammy.ramos@metric', 'oscar.moreno@metric', 'yeni.aleman@metric',
        'daria.rodriguez@metric'].forEach(e =>
        assert.ok(!src.includes(e), f + ' still has ' + e));
    });
});

t('correcting an email keeps the settings on that row', () => {
  // `expected` is Lyndsay's to set. A correction that reset it would replace a
  // deliberate NULL — "no target yet" — with the same value by accident, and
  // nobody would know which it was.
  const script = read('scripts/load-social-roster.js');
  const block = script.slice(script.indexOf('for (const r of fixes)'),
    script.indexOf('const after = await'));
  assert.match(block, /\.update\(\{ email: r\.email/);
  assert.ok(!/expected/.test(block.replace(/\(expected.*?kept\)/g, '')),
    'the correction writes expected as well');
});

t('the dry run shows the corrections it would make', () => {
  // A rehearsal that does not show the change is not a rehearsal. The first
  // version computed them after the dry-run return.
  const script = read('scripts/load-social-roster.js');
  assert.ok(script.indexOf('EMAIL CORRECTIONS') < script.indexOf('if (!WRITE) {'),
    'the corrections are printed only on a write');
});

// ---- 5. the create panel points at the reset -------------------------------------------

t('the one-time password says where to go if it is lost', () => {
  const app = read('public/app.js');
  assert.match(app, /SHOWN ONCE\./);
  assert.match(app, /do not create the account again/);
  assert.match(app, /Reset temp password/);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
