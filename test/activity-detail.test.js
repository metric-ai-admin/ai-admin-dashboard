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
const css = read(path.join('public', 'styles.css'));

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
  // The timeline is built from `data`, not from `human` — grouped for reading,
  // but never filtered. Asserted on the SOURCE rather than the exact
  // expression, so adding a display transform does not look like a regression.
  assert.ok(/timeline: ACTS\.groupRuns\(data \|\| \[\]\)/.test(body)
    || /timeline: data \|\| \[\]/.test(body), 'the timeline is filtered too');
  assert.ok(!/timeline: .*human/.test(body), 'system rows are dropped from the timeline');
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

console.log('\ngrouping a burst into one line');
t('consecutive identical actions in the same minute fold', () => {
  // One click of "Sync from AppFolio" fires seven parallel requests and leaves
  // seven rows in the same second. The log is right; the screen was not.
  const r = A.groupRuns([
    { at: '2026-10-06T14:51:03Z', user_email: 'a', action: 'Synced maintenance data from AppFolio', event: 'write' },
    { at: '2026-10-06T14:51:04Z', user_email: 'a', action: 'Synced maintenance data from AppFolio', event: 'write' },
    { at: '2026-10-06T14:51:09Z', user_email: 'a', action: 'Synced maintenance data from AppFolio', event: 'write' },
  ]);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].groupCount, 3);
});
t('a different minute starts a new line', () => {
  const r = A.groupRuns([
    { at: '2026-10-06T14:51:03Z', user_email: 'a', action: 'X', event: 'write' },
    { at: '2026-10-06T15:20:00Z', user_email: 'a', action: 'X', event: 'write' },
  ]);
  assert.strictEqual(r.length, 2, 'two bursts an hour apart folded together');
});
t('different people never fold', () => {
  const r = A.groupRuns([
    { at: '2026-10-06T14:51:03Z', user_email: 'a', action: 'X', event: 'write' },
    { at: '2026-10-06T14:51:04Z', user_email: 'b', action: 'X', event: 'write' },
  ]);
  assert.strictEqual(r.length, 2);
});
t('rows with no action never fold', () => {
  // An unlabelled row says nothing about what happened, so collapsing several
  // would claim they were the same thing when nobody knows that.
  const r = A.groupRuns([
    { at: '2026-10-06T14:51:03Z', user_email: 'a', action: null, event: 'view' },
    { at: '2026-10-06T14:51:04Z', user_email: 'a', action: null, event: 'view' },
  ]);
  assert.strictEqual(r.length, 2);
});
t('it does not modify the rows it was given', () => {
  // A reading aid, not a rewrite: an audit log that discards rows is not one.
  const input = [{ at: '2026-10-06T14:51:03Z', user_email: 'a', action: 'X', event: 'write' }];
  A.groupRuns(input);
  assert.strictEqual(input[0].groupCount, undefined, 'groupRuns mutated its input');
});
t('the CSV is NOT grouped', () => {
  // The export is the record; grouping belongs on screen.
  const i = code.indexOf("app.get('/api/activity/detail'");
  const body = code.slice(i, i + 4200);
  assert.ok(body.indexOf("format") < body.indexOf('ACTS.groupRuns'),
    'the CSV branch sits after the grouping and would export collapsed rows');
});

console.log('\nsection ids read as names');
t('the known ones are mapped', () => {
  assert.strictEqual(A.sectionLabel('crm'), 'BD CRM');
  assert.strictEqual(A.sectionLabel('morning'), 'Morning Report');
  assert.strictEqual(A.sectionLabel('activity'), 'Activity Logs');
  assert.strictEqual(A.sectionLabel('sixpm'), '6 PM Report');
});
t('an unmapped id tidies itself rather than reading Unknown', () => {
  // A new section should be readable the day it is added, not the day somebody
  // remembers to edit the map.
  assert.strictEqual(A.sectionLabel('unit-turns'), 'Unit Turns');
  assert.strictEqual(A.sectionLabel(''), null);
});
t('there is ONE map and the browser loads it', () => {
  assert.ok(/src="\/lib\/activity-actions\.js"/.test(html), 'the tab cannot reach the map');
  assert.ok(/window\.ActivityActions && window\.ActivityActions\.sectionLabel/.test(appCode),
    'the tab keeps its own copy of the names');
});

console.log('\nevery time is Central');
t('the tab formats in America/Chicago and writes CT', () => {
  // toLocaleString uses the BROWSER's zone: Arturo in Venezuela read 10:51 AM
  // for something that happened at 9:51 in Austin. Session start and last
  // activity were already computed on Central days, so the clock has to agree
  // with them or one row says two things on one screen.
  assert.ok(/const ACT_TZ = 'America\/Chicago'/.test(appCode));
  assert.ok(/timeZone: ACT_TZ \}\) \+ ' CT'/.test(appCode), 'the zone is not written on screen');
});
t('no time in the detail or timeline renders in the browser zone', () => {
  const i = appCode.indexOf('let actOffset = 0;');
  const body = appCode.slice(i, appCode.indexOf('async function loadKpiRecaps'));
  const bare = body.match(/toLocale(Time|Date)?String\('en-US', \{(?![^}]*timeZone)[^}]*\}/g) || [];
  assert.deepStrictEqual(bare, [], 'these render in the reader’s zone: ' + bare.join(' | '));
});

console.log('\nthe weekly matrix');
t('it counts clicks, not requests', () => {
  // One "Sync from AppFolio" is seven parallel requests, so Erick showed 45 in
  // Maintenance for about six clicks and the column dwarfed every other
  // section.
  const i = code.indexOf("app.get('/api/activity/weekly'");
  const body = code.slice(i, code.indexOf('const KPI_RECAP_ROLES', i));
  assert.ok(/ACTS\.groupRuns\(list\)/.test(body), 'the matrix still tallies raw requests');
});
t('it groups PER PERSON before tallying', () => {
  // groupRuns only folds consecutive rows. With several people interleaved in
  // one stream, the same person's burst is not adjacent to itself and most of
  // it would not fold.
  const i = code.indexOf("app.get('/api/activity/weekly'");
  const body = code.slice(i, code.indexOf('const KPI_RECAP_ROLES', i));
  assert.ok(/const byPerson = new Map\(\)/.test(body), 'rows are grouped across people');
  assert.ok(/\.order\('at', \{ ascending: true \}\)/.test(body),
    'rows arrive unordered, so consecutive means nothing');
});
t('it selects action, which grouping needs', () => {
  const i = code.indexOf("app.get('/api/activity/weekly'");
  const body = code.slice(i, code.indexOf('const KPI_RECAP_ROLES', i));
  assert.ok(/select\('user_email,user_name,user_role,event,action,section,at'\)/.test(body),
    'action is not selected, so every row would look unlabelled and never fold');
});
t('the week is bounded on CENTRAL days', () => {
  // 'start + T00:00:00Z' begins at 7pm the previous evening in Austin: the
  // week picked up five hours of the week before and lost five of its own.
  const i = code.indexOf("app.get('/api/activity/weekly'");
  const body = code.slice(i, code.indexOf('const KPI_RECAP_ROLES', i));
  assert.ok(/chicagoStartOfDayISO\(start\)/.test(body), 'the week starts at a UTC midnight');
  assert.ok(!/start \+ 'T00:00:00Z'/.test(body));
});
t('columns are ordered by use, busiest first', () => {
  // Alphabetical put Accounting in front of Maintenance on a screen read left
  // to right and often cut off at the right edge.
  const i = code.indexOf("app.get('/api/activity/weekly'");
  const body = code.slice(i, code.indexOf('const KPI_RECAP_ROLES', i));
  assert.ok(/\(sectionTotals\[b\] \|\| 0\) - \(sectionTotals\[a\] \|\| 0\)/.test(body));
  assert.ok(/\|\| a\.localeCompare\(b\)/.test(body), 'two equally used sections would order randomly');
});

console.log('\nthe matrix fits inside its card');
t('it scrolls horizontally rather than overflowing', () => {
  assert.ok(/\.act-scroll \{ overflow-x: auto/.test(css), 'there is no scroller');
  assert.ok(/class="act-scroll"/.test(appCode), 'the table is not inside it');
});
t('the Person column is pinned', () => {
  assert.ok(/\.act-matrix \.act-sticky \{[\s\S]*?position: sticky; left: 0/.test(css));
  assert.ok(/<th class="act-sticky">Person<\/th>/.test(appCode));
  assert.ok(/<td class="act-sticky">/.test(appCode));
});
t('the pinned cell has a background of its own', () => {
  // Without one the scrolled columns show through it and it reads as a
  // rendering fault.
  const i = css.indexOf('.act-matrix .act-sticky');
  const body = css.slice(i, i + 220);
  assert.ok(/background: var\(--bg-elevated\)/.test(body), 'the sticky cell is transparent');
});
t('headers use the shared section names', () => {
  assert.ok(/<th title="\$\{esc\(c\)\}">\$\{esc\(actSection\(c\)\)\}<\/th>/.test(appCode),
    'the matrix prints raw section ids');
});
t('a name in the matrix opens that person’s day', () => {
  const i = appCode.indexOf('act-matrix');
  const body = appCode.slice(i, i + 1200);
  assert.ok(/class="act-person" data-email/.test(body), 'the names are not clickable');
});

console.log(`\n${pass} passing`);
