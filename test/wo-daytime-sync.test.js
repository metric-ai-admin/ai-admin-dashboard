// The daytime work-order sync, and the open list Jay can download.
//
// WHY THE SYNC NEEDED A SECOND SCHEDULE. The probe settled it on 2026-10-20:
// AppFolio really did hold 27 Ready to Bill under both the sync's filter and
// the reconciliation's, and the 2 in our table was the figure from 06:00. The
// sync was not broken and the filters were not wrong — the work moved during
// the day and nothing asked again until the next morning, so Erick's board
// read a figure that aged all afternoon.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

console.log('work orders: daytime sync and the open list');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// ---- the schedule -----------------------------------------------------------

t('it runs every two hours from 07:00 to 19:00', () => {
  const m = server.match(/const WO_DAYTIME_HOURS = '([^']+)'/);
  assert.ok(m, 'the hours are not declared');
  const hours = m[1].split(',').map(Number);
  assert.deepStrictEqual(hours, [7, 9, 11, 13, 15, 17, 19]);
  assert.strictEqual(hours.length, 7, 'seven runs, so seven AppFolio calls a day');
});

t('it does not land on the closure loop\'s minute', () => {
  // The closure loop already runs at minute 0 of every hour from 07:00 to
  // 19:00. Two pulls on the same minute would undo the staggering for every
  // hour they share, which is all of them.
  assert.match(server, /cron\.schedule\(`20 \$\{WO_DAYTIME_HOURS\} \* \* \*`/);
  assert.match(server, /cron\.schedule\('0 7-19 \* \* \*'/, 'the closure loop moved');
});

t('it calls the same route the 06:00 sync does', () => {
  // Not a second implementation of the pull. One route, two schedules.
  const at = server.indexOf('WO_DAYTIME_HOURS = ');
  const block = server.slice(at, at + 900);
  assert.match(block, /callOwnRoute\('\/api\/maintenance\/sync', \{\}\)/);
  assert.match(block, /wo-sync-day/, 'the log line does not say which run it was');
});

t('a failure is logged where the other jobs report', () => {
  const at = server.indexOf('WO_DAYTIME_HOURS = ');
  const block = server.slice(at, at + 900);
  assert.match(block, /logLine\(`\[wo-sync-day\] FAILED/);
  assert.ok(!/console\.error/.test(block), 'a silent failure here puts the board back to 06:00 data');
});

t('a scheduled sync is one AppFolio call', () => {
  // The arithmetic behind "7 more calls a day". The route contains TWO
  // appfolioReportsFetch calls and a first version of this test counted them
  // both and reported 14 — but the second is inside `if (dryRun)`, and the
  // cron calls with {}. So the scheduled cost is one call, and this checks
  // the shape that makes that true rather than the raw count.
  const at = server.indexOf("app.post('/api/maintenance/sync'");
  assert.ok(at > 0);
  const body = server.slice(at, server.indexOf('app.', at + 10));
  const calls = [...body.matchAll(/appfolioReportsFetch\(/g)].map(m => m.index);
  assert.strictEqual(calls.length, 2, 'the route changed shape; re-check the cost');
  const dryRunAt = body.indexOf('if (dryRun) {');
  assert.ok(dryRunAt > 0, 'the dry-run branch is gone');
  assert.ok(calls[0] < dryRunAt, 'the unconditional call is the first one');
  assert.ok(calls[1] > dryRunAt, 'the second call left the dry-run branch — 7 runs is now 14 calls');
});

// ---- the download -----------------------------------------------------------

const routeAt = server.indexOf("'/api/maintenance/open-work-orders.xlsx'");
const route = server.slice(routeAt, server.indexOf('// AND AGAIN THROUGH THE DAY', routeAt));

t('it is a download behind a login', () => {
  // Generated on Render it landed on a disk nobody can reach: the file
  // existed and was useless.
  assert.ok(routeAt > 0, 'the route is not there');
  assert.match(route, /requireAuth, requireMetricAccess/);
  assert.match(route, /Content-Disposition', 'attachment/);
  assert.match(route, /spreadsheetml\.sheet/);
});

t('it carries the five columns and no resident data', () => {
  ['Work order', 'Property', 'Status', 'We count it as', 'Priority']
    .forEach(c => assert.ok(route.includes("'" + c + "'"), c));
  // Against the SHEET, not the whole handler: "tenant_requested" is a
  // work-order type in the request and has nothing to do with a resident,
  // and matching the bare word there failed this for the wrong reason.
  const sheet = route.slice(route.indexOf('const out = open.map'),
    route.indexOf('const workDone'));
  ['tenant_name', 'resident', 'description', 'phone', 'unit_name']
    .forEach(f => assert.ok(!new RegExp(f, 'i').test(sheet), f + ' reaches the file'));
});

t('it uses the shared rule and the shared exclusions', () => {
  assert.match(route, /WOS\.isOpen\(st\(r\)\)/);
  assert.match(route, /WOS\.isWorkDone\(st\(r\)\)/);
  assert.match(route, /propertyIsExcluded\(r\.property_name\)/,
    'the diff would be dominated by rows neither screen shows');
});

t('the About sheet states the definition, not just the totals', () => {
  assert.match(route, /Ready to Bill is CLOSED/);
  assert.match(route, /Work Done is OPEN/);
  assert.match(route, /neither open nor closed/);
  assert.match(route, /Diff the Work order column/, 'it does not say what to do with it');
});

t('a failed pull answers with a reason, not an empty workbook', () => {
  // An empty sheet would read as "we have no open work orders", which is the
  // most misleading possible answer to this question.
  assert.match(route, /res\.status\(502\)/);
  assert.match(route, /Could not build the list/);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
