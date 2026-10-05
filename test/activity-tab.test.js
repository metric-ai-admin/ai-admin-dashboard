// Activity Logs phase 3 — the tab.
//
// This is a record of what named colleagues did, read by the CEO. Two things
// therefore have to hold and both are tested: no other role can reach it, and
// the screen says out loud that dashboard use is not work.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const server = read('server.js');
const app = read(path.join('public', 'app.js'));
const html = read(path.join('public', 'index.html'));
// Match code, never the comments around it.
const code = server.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const appCode = app.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

console.log('nobody else can see it');
t('both routes carry the role guard, not just the tab', () => {
  // A hidden button is not a lock.
  ['/api/activity/last-seen', '/api/activity/weekly'].forEach(r => {
    const re = new RegExp("app\\.get\\('" + r + "', requireAuth, requireRole\\(\\.\\.\\.ACTIVITY_ROLES\\)");
    assert.ok(re.test(code), r + ' is not gated');
  });
});
t('the roles are admin and ceo, and only those', () => {
  assert.ok(/const ACTIVITY_ROLES = \['admin', 'ceo'\];/.test(code));
});
t('the tab is granted to admin and ceo only', () => {
  const m = appCode.match(/const TAB_ACCESS = \{[\s\S]*?\n\};/);
  assert.ok(m, 'TAB_ACCESS moved');
  const block = m[0];
  const roles = [...block.matchAll(/^\s{2}([a-z_]+):\s*\[([^\]]*)\]/gm)]
    .filter(x => /'activity'/.test(x[2])).map(x => x[1]);
  assert.deepStrictEqual(roles.sort(), ['admin', 'ceo'],
    'activity is granted to: ' + roles.join(', '));
});
t('the view beacon route is NOT the one being widened', () => {
  // Phase 2's write path stays on requireAuth for every signed-in user; only
  // the READ side is admin/ceo.
  assert.ok(/app\.post\('\/api\/activity\/view', requireAuth, \(req, res\)/.test(code),
    'the beacon route picked up a role guard and ordinary users stopped being logged');
});

console.log('\nthe disclaimer is on screen and not removable by a script failure');
t('it is in the markup, not rendered by app.js', () => {
  // If it were drawn by the loader, a failed fetch would leave the numbers
  // with no caveat attached.
  assert.ok(/Measures dashboard use only/.test(html), 'the disclaimer is not in index.html');
  assert.ok(/not performance or work done outside the dashboard/.test(html));
});
t('it sits above both panels', () => {
  const d = html.indexOf('Measures dashboard use only');
  assert.ok(d > 0);
  assert.ok(d < html.indexOf('id="act-lastseen"'), 'the last-seen panel is above the caveat');
  assert.ok(d < html.indexOf('id="act-weekly"'), 'the weekly panel is above the caveat');
});
t('the API repeats it, so a copied payload carries it too', () => {
  assert.ok(/disclaimer: 'Measures dashboard use only/.test(code));
});

console.log('\nlast seen — the people who never signed in are the point');
t('it starts from dashboard_users, not from the log', () => {
  // Building the list from activity_log would silently drop everybody who
  // never used it, which is exactly the group being asked about.
  const i = code.indexOf("app.get('/api/activity/last-seen'");
  const body = code.slice(i, code.indexOf("app.get('/api/activity/weekly'"));
  assert.ok(body.indexOf("from('dashboard_users')") < body.indexOf("from('activity_log')"),
    'the log is the starting point');
  assert.ok(/\(users \|\| \[\]\)\.map/.test(body), 'the output is built from the log rows');
});
t('never-signed-in is its own flag, not a null to be guessed from', () => {
  const i = code.indexOf("app.get('/api/activity/last-seen'");
  const body = code.slice(i, code.indexOf("app.get('/api/activity/weekly'"));
  assert.ok(/never_signed_in: !b\.lastAt/.test(body));
});
t('the UI prints the word, not a dash or a zero', () => {
  const i = appCode.indexOf('async function loadActivity');
  const body = appCode.slice(i, appCode.indexOf('async function loadKpiRecaps'));
  assert.ok(/<b>never<\/b>/.test(body), 'a never-signed-in user renders like any other');
});
t('the retention window is reported, so silence can be read correctly', () => {
  // Without it, 200 days without a login looks the same as rows that aged out.
  const i = code.indexOf("app.get('/api/activity/last-seen'");
  const body = code.slice(i, code.indexOf("app.get('/api/activity/weekly'"));
  assert.ok(/retentionDays: 90/.test(body) && /oldestRow: oldest/.test(body));
});
t('the newest row wins, since rows come back newest first', () => {
  const i = code.indexOf("app.get('/api/activity/last-seen'");
  const body = code.slice(i, code.indexOf("app.get('/api/activity/weekly'"));
  assert.ok(/\.order\('at', \{ ascending: false \}\)/.test(body));
  assert.ok(/if \(!b\.lastAt\) b\.lastAt = r\.at;/.test(body), 'the oldest row would overwrite the newest');
});

console.log('\nthe weekly matrix');
t('the week is Sun–Sat, from the shared module', () => {
  const i = code.indexOf("app.get('/api/activity/weekly'");
  const body = code.slice(i, i + 2600);
  assert.ok(/WEEK\.weekEndYMD\(todayCT, WEEK\.DASHBOARD\)/.test(body), 'the week is computed locally');
  assert.ok(/WEEK\.weekStartYMD\(ending, WEEK\.DASHBOARD\)/.test(body));
});
t('a day is a Central day, not a UTC one', () => {
  // A 7pm Austin session belongs to that day. Using the UTC date would move it
  // to tomorrow and inflate somebody's active days.
  const i = code.indexOf("app.get('/api/activity/weekly'");
  const body = code.slice(i, i + 2600);
  assert.ok(/WEEK\.toChicagoYMD\(new Date\(r\.at\)\)/.test(body));
});
t('the rate counts only working days that have happened', () => {
  const i = code.indexOf("app.get('/api/activity/weekly'");
  const body = code.slice(i, i + 2600);
  assert.ok(/dow >= 1 && dow <= 5/.test(body), 'weekends count against the rate');
  assert.ok(/ymd <= todayCT/.test(body), 'a week in progress is scored against days that have not happened');
});
t('the rate cannot exceed 100%', () => {
  // Somebody who works Saturday is not 120% active, and a rate over 100 reads
  // as a target beaten.
  const i = code.indexOf("app.get('/api/activity/weekly'");
  const body = code.slice(i, i + 2600);
  assert.ok(/Math\.min\(1,/.test(body));
});
t('a week with no working days yet gives null, not a divide by zero', () => {
  const i = code.indexOf("app.get('/api/activity/weekly'");
  const body = code.slice(i, i + 2600);
  assert.ok(/workingDays\.length\s*\n?\s*\?/.test(body) && /: null,/.test(body));
});
t('the week can be asked for explicitly, and a bad value is ignored', () => {
  const i = code.indexOf("app.get('/api/activity/weekly'");
  const body = code.slice(i, i + 900);
  assert.ok(/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$/.test(body), 'week_ending is used unvalidated');
});

console.log('\nthe tab exists and loads');
t('the button and the section are both there', () => {
  assert.ok(/data-tab="activity"/.test(html), 'no sidebar button');
  assert.ok(/id="tab-activity"/.test(html), 'no section to show');
});
t('it is in the Reports group', () => {
  const g = html.indexOf('>Reports<');
  const btn = html.indexOf('data-tab="activity"');
  const next = html.indexOf('nav-group-label', g + 10);
  assert.ok(g > 0 && btn > g && btn < next, 'the button is not inside the Reports group');
});
t('loadTab calls the loader', () => {
  assert.ok(/if \(tab === 'activity'\) loadActivity\(\);/.test(appCode));
});
t('a failed panel says so instead of staying on Loading…', () => {
  const i = appCode.indexOf('async function loadActivity');
  const body = appCode.slice(i, appCode.indexOf('async function loadKpiRecaps'));
  assert.strictEqual((body.match(/Could not load:/g) || []).length, 2,
    'one of the two panels has no failure path');
  // Each panel has its own try, so one failing does not hide the other.
  assert.strictEqual((body.match(/try \{/g) || []).length, 2);
});

console.log(`\n${pass} passing`);
