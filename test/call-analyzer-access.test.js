// Who may open the Call Analyzer, and what gets recorded when they act.
//
// Lyndsay granted Jay, Bekah and Kara full access on 2026-10-07 — grades, red
// flags and coaching notes. Two of the three are not admins (Bekah is
// regional_director, Kara is resident_success), and until that day EVERY
// /api/calls/* route was requireRole('admin') AND the named allowlist. So
// adding them to the list alone would have done nothing: the tab would appear
// and every request behind it would 403. The admin check is gone and the named
// list is now the whole lock, on both sides.
//
// That makes the guard load-bearing in a way it was not before. With admin in
// front, a route that lost requireCallAnalyzer was still admin-only. Now it
// would be open to every logged-in user — Katie, Rhoxie, Erick — so the test
// that every route carries it is the thing standing between a missing
// middleware and call recordings of named staff.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ACTS = require('../lib/activity-actions.js');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const appjs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

// Every route this module owns, as declared.
const CALL_ROUTES = [...server.matchAll(
  /app\.(get|post|patch|delete|put)\('(\/api\/calls\/[^']*|\/api\/sv\/grade\/backfill)'([^)]*)/g)]
  .map(m => ({ method: m[1].toUpperCase(), route: m[2], guards: m[3] }));

// ---- the lock ---------------------------------------------------------------
t('there are Call Analyzer routes to talk about', () => {
  assert.ok(CALL_ROUTES.length >= 15, 'found ' + CALL_ROUTES.length);
});

t('every route carries requireCallAnalyzer', () => {
  const bare = CALL_ROUTES.filter(r => !/requireCallAnalyzer/.test(r.guards));
  assert.deepStrictEqual(bare.map(r => r.method + ' ' + r.route), [],
    'without admin in front, a route missing this guard is open to every logged-in user');
});

t('every route still requires a session', () => {
  const bare = CALL_ROUTES.filter(r => !/requireAuth/.test(r.guards));
  assert.deepStrictEqual(bare.map(r => r.method + ' ' + r.route), []);
});

t('no route still requires admin, or Bekah and Kara would 403 behind a visible tab', () => {
  const stillAdmin = CALL_ROUTES.filter(r => /requireRole\('admin'\)/.test(r.guards));
  assert.deepStrictEqual(stillAdmin.map(r => r.method + ' ' + r.route), []);
});

t('the five named people are the default list', () => {
  const m = /const CALL_ANALYZER_DEFAULT_USERS = '([^']+)'/.exec(server);
  assert.ok(m, 'the default must be a named constant, not buried in an expression');
  assert.deepStrictEqual(m[1].split(',').map(s => s.trim()),
    ['arturo', 'lyndsay', 'jay', 'bekah', 'kara']);
});

t('access is by person, never by role', () => {
  const block = server.slice(server.indexOf('const CALL_ANALYZER_DEFAULT_USERS'),
    server.indexOf('function requireCallAnalyzer'));
  assert.ok(/user\.username/.test(block));
  assert.ok(!/\.role\b/.test(block),
    'granting by role would hand the next regional_director call recordings about named staff');
});

t('a user with no username is refused, not matched on an empty string', () => {
  const block = server.slice(server.indexOf('const mayUseCallAnalyzer'),
    server.indexOf('console.log(`[call-analyzer]'));
  assert.ok(/!!\(user && user\.username\)/.test(block),
    'with admin gone there is nothing in front of this check any more');
});

t('the effective list is printed at boot', () => {
  // CALL_ANALYZER_USERS in the environment REPLACES the default silently. If
  // Render still holds the old pair, this deploy changes nothing for the three
  // new people — and that needs to be findable in a log, not guessed at.
  assert.ok(/\[call-analyzer\] access:/.test(server));
  assert.ok(/overriding the default/.test(server));
});

// ---- the tab ----------------------------------------------------------------
t("Bekah's and Kara's roles may render the tab", () => {
  const rd = /regional_director:\s*(\[[^\]]*\])/.exec(appjs)[1];
  const rs = /resident_success:\s*(\[[^\]]*\])/.exec(appjs)[1];
  assert.ok(/'calls'/.test(rd), 'regional_director: ' + rd);
  assert.ok(/'calls'/.test(rs), 'resident_success: ' + rs);
});

t('but the role list alone never opens it', () => {
  // A second regional_director would have the tab key allowed and still see
  // nothing, because callAnalyzer comes from the named list on the server.
  assert.ok(/\.filter\(tab => tab !== 'calls' \|\| currentUser\.callAnalyzer\)/.test(appjs));
});

t('roles that were not granted it do not have the key', () => {
  for (const role of ['maintenance', 'bd_agent', 'leasing', 'collections_leasing', 'accounting']) {
    const m = new RegExp(role + ":\\s*(\\[[^\\]]*\\])").exec(appjs);
    if (!m) continue;
    assert.ok(!/'calls'/.test(m[1]), role + ' should not list calls: ' + m[1]);
  }
});

t('the session carries the flag, recomputed rather than trusted from the token', () => {
  // A token issued before today carries the old value; /api/auth/me recomputes.
  const me = server.slice(server.indexOf("callAnalyzer: mayUseCallAnalyzer(user)"));
  assert.ok(me.length > 0, 'the me route must recompute it');
  assert.ok(/callAnalyzer: mayUseCallAnalyzer\(dbUser\)/.test(server), 'and login must set it');
});

// ---- what gets recorded -----------------------------------------------------
//
// Nothing was built for this: activityWriteLogger is mounted on /api above
// these routes and lib/activity-actions.js already names each action. These
// assertions are what stops that quietly regressing now that three more people
// are using it.
t('every red flag and coaching action has a name in the catalogue', () => {
  const must = [
    ['POST', '/api/calls/flag'],
    ['PATCH', '/api/calls/flag/22841'],
    ['DELETE', '/api/calls/flag/22841'],
    ['POST', '/api/calls/22841/coaching-reviews'],
    ['DELETE', '/api/calls/22841/coaching-reviews'],
    ['POST', '/api/calls/grade'],
    ['PATCH', '/api/calls/rubric-suggestions/7'],
  ];
  for (const [m, p] of must) {
    const d = ACTS.describe(m, p);
    assert.ok(d && d.label, 'uncatalogued: ' + m + ' ' + p);
    assert.strictEqual(d.entity, 'call', m + ' ' + p + ' -> ' + JSON.stringify(d));
    assert.ok(!d.system, m + ' ' + p + ' must count as a person acting, not a system event');
  }
});

t('the labels say what happened, not which endpoint was called', () => {
  assert.strictEqual(ACTS.describe('POST', '/api/calls/flag').label, 'Flagged a call');
  assert.strictEqual(ACTS.describe('DELETE', '/api/calls/flag/1').label, 'Removed a call flag');
  assert.strictEqual(ACTS.describe('POST', '/api/calls/1/coaching-reviews').label,
    'Added a coaching review');
});

t('the section reads as a person would name it', () => {
  assert.strictEqual(ACTS.sectionLabel('calls'), 'Call Analyzer');
});

t('the actor is taken from the session, never from the request body', () => {
  const fn = server.slice(server.indexOf('function activityActor'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(/const u = req\.user;/.test(body));
  assert.ok(/user_name: u\.name/.test(body), 'the name is what the log is read by');
  assert.ok(!/req\.body/.test(body), 'a body-supplied name would let anyone sign someone else\'s action');
});

t('the write logger is mounted before these routes, so they are covered', () => {
  const mount = server.indexOf("app.use('/api', activityWriteLogger)");
  const first = server.indexOf("app.post('/api/calls/grade'");
  assert.ok(mount > 0 && first > mount,
    'Express runs middleware in mount order; a route declared first is not covered');
});

console.log(`\n${pass} passing`);
