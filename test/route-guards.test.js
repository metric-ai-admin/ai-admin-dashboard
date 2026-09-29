// Every route is authenticated unless it is on the allowlist below.
//
// WHY THIS FILE EXISTS. On 2026-09-29 an audit found 51 routes reachable with
// no credential at all on the public Render URL: 214 tasks with their full note
// history, Lyndsay's calendar with attendees and join links, 261 work orders,
// the Asana workspace, and — worst — POST /api/crm/bulk-import, an unauthentic-
// ated upsert into five production tables using the service-role key.
//
// None of it was malice or carelessness in one place. It was age: tasks,
// lyndsay-queue, summary, calendar, asana and assignments all predate
// requireAuth, and nobody went back to add the guard when it arrived. Every
// module written after it is correctly gated. So the failure mode is not "we
// forgot once", it is "the default is open and nothing notices" — which is
// exactly what a test can fix and a code review cannot.
//
// Adding a route with no guard now fails the build. Adding one to ALLOWED is a
// deliberate, reviewable line in a diff.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

const GUARDS = [
  'requireAuth', 'requireRole', 'requireCallAnalyzer', 'requireVacancy',
  'requireMetricAccess', 'requireMetricAdmin', 'requireCRM',
  'requireCopilotApiKey', 'requireSession',
];

// Public ON PURPOSE. Each line needs a reason, because each line is a hole.
const ALLOWED = new Map([
  ['GET /health',                 'liveness; reports no data and is the anti-hibernation ping'],
  ['GET /ping',                   'liveness; uptime only'],
  ['POST /api/auth/login',        'the login itself — cannot require a session to get one'],
  ['POST /api/auth/logout',       'clears the cookie; nothing to leak'],
  ['GET /api/auth/me',            'returns 401 by itself when there is no session'],
  ['POST /api/auth/reset-password', 'pre-login by nature; rate-limited instead (15 min, 3 tries, per IP and per username)'],
  ['GET /auth/login',             'starts the Microsoft OAuth redirect'],
  ['GET /auth/callback',          'Azure redirects here; the code is validated by Azure'],
  ['ALL /mcp',                    'validates a Bearer token against MCP_AUTH_TOKEN inside the handler'],
  ['USE /lib',                    'static shared browser code (lib/week.js), fetched before login like app.js and styles.css — keep lib/ free of anything that is not public client code'],
]);

const FILES = ['server.js', 'metric-routes.js'];
const ROUTE = /^\s*(?:app|router)\.(get|post|put|patch|delete|all|use)\s*\(\s*(['"`])([^'"`]*)\2\s*,?([\s\S]*)$/;

function routes() {
  const out = [];
  for (const f of FILES) {
    const lines = fs.readFileSync(path.join(__dirname, '..', f), 'utf8').split('\n');
    lines.forEach((l, i) => {
      const m = ROUTE.exec(l);
      if (!m) return;
      const rest = m[4] || '';
      // Middleware is whatever sits between the path and the handler.
      const cut = rest.search(/async\s*\(|\(\s*req|function\s*\(/);
      const head = cut >= 0 ? rest.slice(0, cut) : rest;
      out.push({
        file: f, line: i + 1, key: `${m[1].toUpperCase()} ${m[3]}`,
        guarded: GUARDS.some(g => head.includes(g)),
      });
    });
  }
  return out;
}

const all = routes();

console.log('every route carries a guard or an explicit exemption');
t('the scanner still finds the routes (a silent zero would pass everything)', () => {
  assert.ok(all.length > 200, `only found ${all.length} routes — the pattern has drifted`);
});
t('no route is unauthenticated unless it is on the allowlist', () => {
  const bad = all.filter(r => !r.guarded && !ALLOWED.has(r.key));
  assert.strictEqual(bad.length, 0,
    'these routes have no auth guard and are not on the allowlist:\n'
    + bad.map(r => `    ${r.file}:${r.line}  ${r.key}`).join('\n')
    + '\n  Add a guard, or add the route to ALLOWED in this file with the reason it is public.');
});
t('the allowlist has no dead entries', () => {
  // A stale exemption is a hole waiting for someone to re-add the path.
  const live = new Set(all.filter(r => !r.guarded).map(r => r.key));
  const dead = [...ALLOWED.keys()].filter(k => !live.has(k));
  assert.strictEqual(dead.length, 0,
    'allowlisted but no longer an unguarded route (guarded since, or removed): ' + dead.join(', '));
});
t('every allowlist entry states a reason', () => {
  for (const [k, why] of ALLOWED) assert.ok(why && why.length > 15, `${k} has no real reason`);
});

console.log('\nthe specific holes the 2026-09-29 audit found');
const guardOf = key => all.find(r => r.key === key);
[
  'POST /api/crm/bulk-import', 'GET /api/tasks', 'POST /api/tasks', 'DELETE /api/tasks/:id',
  'GET /api/calendar/today', 'GET /api/summary', 'GET /api/lyndsay-queue',
  'GET /api/asana/tasks', 'GET /api/assignments', 'POST /api/assignments',
  'GET /api/lyndsay/tasks', 'GET /api/maintenance/summary', 'GET /api/report',
  'GET /api/triage/summary', 'POST /api/triage/log-session',
  'DELETE /api/maintenance/sops/:id',
].forEach(key => {
  t(`${key} is no longer open`, () => {
    const r = guardOf(key);
    assert.ok(r, `${key} is gone from the codebase — remove it from this list`);
    assert.ok(r.guarded, `${key} is unauthenticated again`);
  });
});

console.log('\nthe reset-password throttle');
t('the limiter is wired into the handler, not merely defined', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const i = src.indexOf("app.post('/api/auth/reset-password'");
  const body = src.slice(i, i + 1200);
  assert.ok(/resetLimited\(`ip:/.test(body), 'not limited per IP');
  assert.ok(/resetLimited\(`user:/.test(body), 'not limited per username');
  assert.ok(/status\(429\)/.test(body), 'does not answer 429 when limited');
});
t('both keys are evaluated — a short-circuit would skip counting one', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const i = src.indexOf("app.post('/api/auth/reset-password'");
  const body = src.slice(i, i + 1200);
  // `a() || b()` would never count b once a tripped, letting one axis mask the other.
  assert.ok(/\[resetLimited[\s\S]{0,160}\]\.some\(Boolean\)/.test(body),
    'the two limiter calls must both run (array + .some), not short-circuit with ||');
});

console.log(`\n${pass} passing`);
