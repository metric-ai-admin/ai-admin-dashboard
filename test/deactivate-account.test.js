// Deactivating an account has to end the access, not just the next login.
//
// WHAT WAS ACTUALLY WRONG. `active` has been enforced at login since the
// column existed, so a deactivated person cannot sign in again. But
// requireAuth verifies a JWT we signed ourselves and asks nothing else — not
// Supabase Auth, not the database — and the token is issued with
// expiresIn: '7d'. Somebody already signed in therefore kept full access for
// up to a WEEK after being deactivated, and the same was true of resetting
// their password, which is how Claudia's departure was handled on 10/21.
//
// The test that matters here is the live-session one. Everything else is
// plumbing around it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const server = read('server.js');
const app = read('public/app.js');

// The source with comments stripped, so prose describing the old behaviour
// cannot satisfy an assertion about the new behaviour.
const codeOf = src => src
  .split('\n')
  .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');
const sCode = codeOf(server);
const aCode = codeOf(app);

console.log('deactivate account');

// ---- the live session --------------------------------------------------------

t('requireAuth rejects a session whose account was deactivated', () => {
  const from = sCode.indexOf('function requireAuth');
  const body = sCode.slice(from, sCode.indexOf('function requireRole'));
  assert.ok(from > 0, 'requireAuth moved');
  assert.ok(/isDeactivated\(req\.user\.userId\)/.test(body),
    'THE 7-DAY GAP IS BACK — a valid token is enough again');
  assert.ok(/401/.test(body), 'a deactivated session must be refused');
  assert.ok(/clearCookie\('dashboardToken'/.test(body),
    'the dead cookie should go, or the browser keeps re-sending it');
});

t('the check runs before the must-change-password branch', () => {
  // Otherwise a deactivated account with a pending temp password would be
  // routed to the change-password screen instead of being refused — and that
  // screen issues a working session.
  const from = sCode.indexOf('function requireAuth');
  const body = sCode.slice(from, sCode.indexOf('function requireRole'));
  assert.ok(body.indexOf('isDeactivated') < body.indexOf('mustChangePassword'),
    'the deactivation check must come first');
});

t('the deny-list is consulted from memory, not queried per request', () => {
  const from = sCode.indexOf('function requireAuth');
  const body = sCode.slice(from, sCode.indexOf('function requireRole'));
  // A select on every authenticated request would put Supabase in the path of
  // every page load in the app.
  assert.ok(!/await .*from\('dashboard_users'\)/.test(body),
    'requireAuth now queries the database on every request');
});

// ---- the refresh that must not fail open ---------------------------------------

t('A FAILED REFRESH KEEPS THE DENY-LIST', () => {
  // The regression that would matter most and show least: emptying the set on
  // a failed read turns a Supabase outage into "everybody deactivated is
  // welcome back", silently, with no error anywhere.
  const from = sCode.indexOf('function deactivatedRefresh');
  const body = sCode.slice(from, sCode.indexOf('function isDeactivated'));
  assert.ok(from > 0, 'deactivatedRefresh is gone');
  assert.ok(/if \(!error && data\)/.test(body),
    'the set is assigned without checking for an error — it can be emptied by a failure');
  // The assignment has to sit INSIDE that guard.
  const guard = body.indexOf('if (!error && data)');
  const assign = body.indexOf('deactivatedIds = new Set(');
  assert.ok(assign > guard && guard > 0, 'the set is assigned outside the error guard');
});

t('the list is loaded at boot, not on the first request', () => {
  assert.ok(/deactivatedRefresh\(true\);/.test(sCode),
    'nothing primes the deny-list at startup');
});

t('deactivating forces the refresh instead of waiting out the TTL', () => {
  const from = sCode.indexOf("'/api/auth/admin/set-active'");
  const body = sCode.slice(from, from + 5000);
  assert.ok(/deactivatedRefresh\(true\)/.test(body),
    'the admin would wait up to 60s for their own click to take effect');
});

// ---- the route ------------------------------------------------------------------

t('set-active is admin only', () => {
  assert.ok(/app\.post\('\/api\/auth\/admin\/set-active', requireMetricAdmin/.test(sCode),
    'the route is not behind requireMetricAdmin');
});

t('a missing active flag is refused, never guessed', () => {
  const from = sCode.indexOf("'/api/auth/admin/set-active'");
  const body = sCode.slice(from, from + 5000);
  assert.ok(/typeof body\.active !== 'boolean'/.test(body),
    'a malformed request could silently open or close an account');
});

t('you cannot deactivate yourself, or the last admin', () => {
  const from = sCode.indexOf("'/api/auth/admin/set-active'");
  const body = sCode.slice(from, from + 5000);
  assert.ok(/req\.user\.userId\) === String\(row\.id\)/.test(body),
    'an admin can end their own session with one click');
  // The guard itself, not its wording: count the OTHER active admins and
  // refuse at one. Reactivate is admin-only, so emptying the role is a door
  // that locks from the outside.
  assert.ok(/\.eq\('role', 'admin'\)\.eq\('active', true\)/.test(body),
    'nothing counts the remaining admins');
  assert.ok(/\(admins \|\| \[\]\)\.length <= 1/.test(body),
    'the last admin can be deactivated, and Reactivate would need an admin');
});

t('both mechanisms are applied: the flag and the Auth ban', () => {
  const from = sCode.indexOf("'/api/auth/admin/set-active'");
  const body = sCode.slice(from, from + 6000);
  assert.ok(/\.update\(\{ active \}\)/.test(body), 'the dashboard flag is not set');
  assert.ok(/ban_duration: active \? 'none' : '876000h'/.test(body),
    'the Supabase Auth ban is not applied or not lifted');
});

t('a failed ban does not fail the whole request', () => {
  // The flag is what locks the dashboard. Failing the request because the
  // second mechanism did not apply would leave the account OPEN.
  const from = sCode.indexOf("'/api/auth/admin/set-active'");
  const body = sCode.slice(from, from + 6000);
  const banAt = body.indexOf('ban_duration');
  const after = body.slice(banAt, banAt + 600);
  assert.ok(/catch \(e\) \{[\s\S]*banNote/.test(after),
    'a ban failure is not caught and reported as a partial result');
});

t('nothing is deleted — history and authorship survive', () => {
  const from = sCode.indexOf("'/api/auth/admin/set-active'");
  const body = sCode.slice(from, from + 6000);
  assert.ok(!/\.delete\(\)/.test(body), 'the route deletes something');
  assert.ok(!/from\('activity_log'\)/.test(body), 'the route touches activity_log rows');
  // The only write to dashboard_users is the flag.
  const updates = body.match(/\.update\(\{[^}]*\}\)/g) || [];
  assert.deepStrictEqual(updates, ['.update({ active })'],
    'the route rewrites more than the flag: ' + updates.join(', '));
});

// ---- the record -------------------------------------------------------------------

t('the action records who did it AND to whom', () => {
  // activity_log has no `detail` column — the allowlist drops any key the
  // table lacks — so anything not in `action` is not recorded at all.
  const from = sCode.indexOf("'/api/auth/admin/set-active'");
  const body = sCode.slice(from, from + 7000);
  const at = body.indexOf('activityLog.log');
  const log = body.slice(at, at + 700);
  assert.ok(/action:/.test(log), 'no action line');
  assert.ok(/username/.test(log), 'the action does not say WHO was deactivated');
  assert.ok(/req\.user\?\.name/.test(log), 'the action does not say who DID it');
  assert.ok(!/detail:/.test(log), 'detail is dropped by the allowlist — it records nothing');
});

t('the two directions are distinguishable in the log', () => {
  const from = sCode.indexOf("'/api/auth/admin/set-active'");
  const body = sCode.slice(from, from + 7000);
  assert.ok(/account_reactivated/.test(body) && /account_deactivated/.test(body),
    'both directions log the same event name');
});

// ---- the screen ---------------------------------------------------------------------

t('the row says Deactivated, and does not rely on looking idle', () => {
  // "Deactivated" and "has not been back" look identical on this table, and
  // only one of them means somebody decided.
  assert.ok(/>Deactivated</.test(aCode), 'the label is gone');
  assert.ok(/u\.active === false/.test(aCode), 'nothing reads the flag');
});

t('the label is a theme token, not a hand-picked hex', () => {
  const at = aCode.indexOf('>Deactivated<');
  const around = aCode.slice(at - 200, at);
  assert.ok(/var\(--critical\)/.test(around), 'the label uses a literal colour');
});

t('a deactivated row offers Reactivate, an active one Deactivate', () => {
  assert.ok(/data-set-active=/.test(aCode), 'no button is rendered');
  assert.ok(/>Reactivate</.test(aCode) && /># ?Deactivate</.test(aCode) === false
    && />Deactivate</.test(aCode), 'both directions must be reachable');
});

t('the buttons are wired, and admin-gated by the same flag as Reset', () => {
  assert.ok(/wireActiveButtons\(ls\)/.test(aCode), 'the buttons are rendered but dead');
  // Rendered inside the same mayReset cell, which is the admin check.
  const at = aCode.indexOf('data-set-active=');
  const before = aCode.slice(Math.max(0, at - 400), at);
  assert.ok(/mayReset/.test(before), 'the control is shown to non-admins');
});

t('the confirmation says what is NOT lost', () => {
  const from = app.indexOf('function wireActiveButtons');
  const body = app.slice(from, from + 3000);
  assert.ok(/nothing is deleted/i.test(body),
    'the fear that stops somebody using this is losing the record — say it');
  assert.ok(/reversible/i.test(body));
  assert.ok(/60 seconds/.test(body), 'the confirmation should state when it takes effect');
});

t('a partial result is shown rather than reported as success', () => {
  const from = app.indexOf('function wireActiveButtons');
  const body = app.slice(from, from + 3000);
  assert.ok(/banNote/.test(body), 'a half-applied change would read as fully applied');
});

// ---- the payload the screen reads ------------------------------------------------------

t('last-seen carries the flag and the username', () => {
  const from = sCode.indexOf("'/api/activity/last-seen'");
  const body = sCode.slice(from, from + 6000);
  assert.ok(/select\('email,name,role,username,active'\)/.test(body),
    'the projection dropped the columns the screen needs');
  assert.ok(/active: u\.active !== false/.test(body),
    'a null active must read as live, not as deactivated');
  assert.ok(/username: u\.username/.test(body), 'the row has nothing to act on');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
