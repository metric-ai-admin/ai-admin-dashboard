// Activity Logs: exports, property names, the day view and the detail table.
//
// The rules are phase 1's and they do not relax as the feature grows: nothing
// blocks the user, no forbidden field is ever stored, and the dashboard's own
// chatter is 'system' rather than somebody working.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const A = require('../lib/activity-actions.js');
const ACT = require('../lib/activity-log.js');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const server = read('server.js');
const app = read(path.join('public', 'app.js'));
const html = read(path.join('public', 'index.html'));
const strip = s => s.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const code = strip(server);
const appCode = strip(app);

console.log('B5 — exports are recorded');
t('an export, a download and a generate each get a label', () => {
  assert.strictEqual(A.describeRead('/api/bd-crm/export/csv').label, 'Exported CSV');
  assert.strictEqual(A.describeRead('/api/appfolio/reports/wo_all/export.pdf').label, 'Exported PDF');
  assert.strictEqual(A.describeRead('/api/vacancy/export.csv').label, 'Exported CSV');
  assert.strictEqual(A.describeRead('/api/reports/daily/generate').label, 'Generated a report');
});
t('an ordinary read gets nothing', () => {
  // Logging every GET would bury the rows that matter under page loads.
  assert.strictEqual(A.describeRead('/api/tasks'), null);
  assert.strictEqual(A.describeRead('/api/activity/detail'), null);
});
t('it is matched on the path, so a new export route is covered the day it lands', () => {
  assert.strictEqual(A.describeRead('/api/something/new/export.csv').label, 'Exported CSV');
});
t('only GETs, and only successful ones', () => {
  const i = code.indexOf('function activityReadLogger');
  const body = code.slice(i, code.indexOf('function activityWriteLogger'));
  assert.ok(/if \(req\.method !== 'GET'\) return next\(\);/.test(body));
  assert.ok(/if \(res\.statusCode >= 400\) return;/.test(body),
    'a refused export would be recorded as data taken');
});
t('it records after the response and calls next()', () => {
  const i = code.indexOf('function activityReadLogger');
  const body = code.slice(i, code.indexOf('function activityWriteLogger'));
  assert.ok(/res\.on\('finish'/.test(body), 'logging sits in the download path');
  assert.ok(/^\s*next\(\);/m.test(body), 'the middleware does not call next()');
  assert.ok(/try \{/.test(body) && /\} catch \{/.test(body));
});
t('it is mounted', () => {
  assert.ok(/app\.use\('\/api', activityReadLogger\);/.test(code));
});

console.log('\nB6 — property names, and nothing else');
t('the column is allowed and the forbidden list is unchanged', () => {
  assert.ok(ACT.ALLOWED.includes('property_name'));
  ['notes', 'tenant', 'resident', 'amount', 'phone', 'balance']
    .forEach(f => assert.ok(ACT.FORBIDDEN.test(f), f + ' is no longer forbidden'));
});
t('a route sets it through a helper, never from the body', () => {
  const i = code.indexOf('function activityProperty');
  assert.ok(i > 0, 'there is no helper');
  const body = code.slice(i, i + 400);
  assert.ok(/if \(!s \|\| s\.length > 80\) return;/.test(body), 'any length of string is accepted');
  assert.ok(/split\(' - '\)\[0\]/.test(body), 'the address is kept with the name');
  assert.ok(!/req\.body/.test(body), 'the helper reads the request body');
});
t('both loggers carry it', () => {
  const r = code.indexOf('function activityReadLogger');
  const w = code.indexOf('function activityWriteLogger');
  const end = code.indexOf('// ---- Auth helpers');
  assert.ok(/property_name: \(res\.locals && res\.locals\.activityProperty\) \|\| null/
    .test(code.slice(r, w)), 'exports never record a property');
  assert.ok(/property_name: \(res\.locals && res\.locals\.activityProperty\) \|\| null/
    .test(code.slice(w, end)), 'writes never record a property');
});

console.log('\nB7 — start and end of the working day');
t('they are computed, not stored', () => {
  // "Session start" is a question about a day, not a property of a row.
  // Computing it means it is right for a day still in progress and nothing has
  // to be back-filled when the definition changes.
  const i = code.indexOf("app.get('/api/activity/day'");
  assert.ok(i > 0, 'there is no day route');
  const body = code.slice(i, i + 2200);
  assert.ok(/sessionStart: human\.length \? human\[0\]\.at : null/.test(body));
  assert.ok(/lastActivity: human\.length \? human\[human\.length - 1\]\.at : null/.test(body));
});
t('the day is a CENTRAL day', () => {
  const i = code.indexOf("app.get('/api/activity/day'");
  const body = code.slice(i, i + 2200);
  assert.ok(/chicagoStartOfDayISO\(date\)/.test(body), 'the day boundary is UTC');
});
t('system rows are out of the summary but still in the timeline', () => {
  // The Command Center autosave is not somebody arriving at work. It stays
  // visible, flagged, so the day can still be read in full.
  const i = code.indexOf("app.get('/api/activity/day'");
  const body = code.slice(i, i + 2200);
  assert.ok(/const human = \(data \|\| \[\]\)\.filter\(r => r\.event !== 'system'\)/.test(body));
  assert.ok(/timeline: data \|\| \[\]/.test(body), 'the timeline is filtered too');
  assert.ok(/\(automatic\)/.test(appCode), 'the UI does not mark automatic rows');
});

console.log('\nC8 — the filterable detail');
t('filtering happens in SQL, not after fetching everything', () => {
  const i = code.indexOf("app.get('/api/activity/detail'");
  const body = code.slice(i, i + 3400);
  assert.ok(/q = q\.eq\('user_email'/.test(body));
  assert.ok(/q = q\.eq\('section'/.test(body));
  assert.ok(/\.range\(offset, offset \+ limit - 1\)/.test(body), 'there is no pagination');
  assert.ok(/\.order\('at', \{ ascending: false \}\)/.test(body), 'oldest first');
});
t('the shortcuts resolve to CENTRAL days', () => {
  // Resolved in UTC, "today" would start at 7pm the evening before and a
  // morning of activity would be missing from it.
  const i = code.indexOf("app.get('/api/activity/detail'");
  const body = code.slice(i, i + 3400);
  ['today', 'yesterday', 'this_week', 'last_week'].forEach(s =>
    assert.ok(new RegExp("'" + s + "'").test(body), s + ' is not a shortcut'));
  assert.ok(/WEEKM\.toChicagoYMD\(new Date\(\)\)/.test(body), 'today is a UTC day');
  assert.ok(/chicagoStartOfDayISO/.test(body), 'the range bounds are UTC midnights');
});
t('the section filter is sanitised like the beacon', () => {
  const i = code.indexOf("app.get('/api/activity/detail'");
  const body = code.slice(i, i + 3400);
  assert.ok(/ACT\.normalizeSection\(req\.query\.section\)/.test(body),
    'a query string goes into the filter unchecked');
});
t('an unknown event value is ignored rather than passed through', () => {
  const i = code.indexOf("app.get('/api/activity/detail'");
  const body = code.slice(i, i + 3400);
  assert.ok(/\.includes\(ev\)\) q = q\.eq\('event', ev\)/.test(body));
});
t('system rows are out unless asked for', () => {
  const i = code.indexOf("app.get('/api/activity/detail'");
  const body = code.slice(i, i + 3400);
  assert.ok(/if \(!req\.query\.includeSystem\) q = q\.neq\('event', 'system'\)/.test(body),
    'the automatic rows bury the human ones');
});
t('the page size is capped', () => {
  const i = code.indexOf("app.get('/api/activity/detail'");
  const body = code.slice(i, i + 3400);
  assert.ok(/Math\.min\(parseInt\(req\.query\.limit, 10\) \|\| 100, 500\)/.test(body),
    'a caller could ask for the whole table');
});

console.log('\nC10 — the CSV is what is on screen');
t('it reuses the same filters', () => {
  assert.ok(/format: 'csv'/.test(appCode), 'the UI has no CSV button');
  assert.ok(/actQuery\(\{ format: 'csv'/.test(appCode),
    'the CSV ignores the filters and exports everything');
});
t('values are escaped, so a comma cannot shift a column', () => {
  const i = code.indexOf("app.get('/api/activity/detail'");
  const body = code.slice(i, i + 3800);
  assert.ok(/\/\[",\\n\]\/\.test\(s\)/.test(body), 'quotes and commas are not escaped');
});
t('only the allowed columns are written out', () => {
  const i = code.indexOf("app.get('/api/activity/detail'");
  const body = code.slice(i, i + 3800);
  const m = body.match(/const cols = \[([\s\S]*?)\];/);
  assert.ok(m, 'the column list is gone');
  ['body', 'payload', 'notes', 'tenant', 'resident', 'amount']
    .forEach(f => assert.ok(!m[1].includes(f), f + ' is exported'));
});
t('it is behind the same role guard as the rest', () => {
  assert.ok(/app\.get\('\/api\/activity\/detail', requireAuth, requireRole\(\.\.\.ACTIVITY_ROLES\)/.test(code));
  assert.ok(/app\.get\('\/api\/activity\/day', requireAuth, requireRole\(\.\.\.ACTIVITY_ROLES\)/.test(code));
});

console.log('\nthe tab');
t('the detail and day panels exist', () => {
  ['act-detail', 'act-f-person', 'act-f-section', 'act-f-event', 'act-f-range',
    'act-csv', 'act-day-card', 'act-day'].forEach(id =>
    assert.ok(html.includes('id="' + id + '"'), 'missing #' + id));
});
t('the disclaimer still sits above everything', () => {
  const d = html.indexOf('Measures dashboard use only');
  assert.ok(d > 0 && d < html.indexOf('id="act-detail"'));
});
t('a label is never built from user input', () => {
  // The catalogue is a lookup table for exactly this reason.
  const i = appCode.indexOf('function actLabel');
  const body = appCode.slice(i, i + 500);
  assert.ok(/if \(r\.action\) return r\.action;/.test(body));
  assert.ok(!/\+ r\.(entity_id|resource)/.test(body), 'an id is concatenated into the label');
});

console.log(`\n${pass} passing`);
