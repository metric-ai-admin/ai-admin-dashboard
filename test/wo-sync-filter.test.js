// The daily sync asked for six status codes and called the answer "every open
// work order".
//
// It was not. The 2026-10-05 sweep across all codes found 113 open where this
// filter returns 95: "Ready to Bill", "Work Done" and some "Waiting" were
// never requested, so they never arrived, and a status nobody asks for looks
// exactly like a status with no rows. Erick's board has been missing them for
// as long as the table has existed.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const WOS = require('../lib/work-order-status.js');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
// Match code, never the comments describing it.
const code = server.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

console.log('the sync uses the DOCUMENTED date syntax');
t('status_date and the range are sent', () => {
  // Asking for every status code still only returned the last ~96 days: the
  // report applies a default window when no range is given. Fifteen invented
  // spellings were silently ignored; this is the one from AppFolio's own
  // documentation, and with it nine work orders open since 2025-09-12 and
  // 2026-02-05 came back.
  const i = code.indexOf('function appfolioWorkOrderFilter');
  assert.ok(i > 0, 'the filter is not built by a function any more');
  const body = code.slice(i, i + 600);
  assert.ok(/status_date: '0'/.test(body), 'status_date (Created On) is not sent');
  assert.ok(/status_date_range_from: APPFOLIO_WO_RANGE_FROM/.test(body));
  assert.ok(/status_date_range_to: today \|\| /.test(body));
});
t('the range reaches far enough back to cover anything still open', () => {
  assert.ok(/APPFOLIO_WO_RANGE_FROM = '2020-01-01'/.test(code),
    'the window starts too late to catch an old open work order');
});
t('the "to" date is computed per call, NOT frozen at module load', () => {
  // A constant evaluated at boot would pin the range to the deploy date and
  // the sync would quietly stop seeing anything created after the day it
  // shipped — no error, found weeks later.
  assert.ok(/function appfolioWorkOrderFilter\(today\)/.test(code),
    'the filter is a constant, so the end date freezes at deploy time');
  assert.ok(/appfolioWorkOrderFilter\(WEEK\.toChicagoYMD\(new Date\(\)\)\)/.test(code),
    'the sync does not pass today in Central');
  assert.ok(!/^const APPFOLIO_WORK_ORDER_FILTER = \{/m.test(code),
    'the old constant filter is still there');
});
t('the status codes are the open ones, confirmed against the live report', () => {
  // All 126 rows the documented pull returns are open by the shared rule — so
  // this list IS the open set, not a guess at it.
  assert.ok(/APPFOLIO_WO_OPEN_CODES = \['0', '1', '2', '9', '11', '3', '6', '8', '12'\]/.test(code));
});
t('the dry run compares against what production does TODAY', () => {
  // Comparing against the six-code list would report an eighteen-row gain
  // banked yesterday and lose this change's thirteen rows inside it.
  const i = code.indexOf('const APPFOLIO_WO_NARROW_FILTER');
  const body = code.slice(i, i + 300);
  assert.ok(/Array\.from\(\{ length: 31 \}/.test(body),
    'the baseline is a filter that is no longer live');
  const uses = code.split('APPFOLIO_WO_NARROW_FILTER').length - 1;
  assert.ok(uses >= 2, 'the baseline filter is declared but never used');
});
t('type and visibility filters are untouched', () => {
  // Changing the date syntax and the type filter in one step would make it
  // impossible to say which produced which rows.
  const i = code.indexOf('function appfolioWorkOrderFilter');
  const body = code.slice(i, i + 600);
  assert.ok(/work_order_types: \['internal', 'tenant_requested', 'unit_turn'\]/.test(body));
  assert.ok(/property_visibility: 'active'/.test(body));
});
t('closed rows are dropped with the shared rule, not a local test', () => {
  const i = code.indexOf("app.post('/api/maintenance/sync'");
  const body = code.slice(i, i + 2500);
  assert.ok(/if \(!WOS\.isOpen\(rec\.status\)\) \{/.test(body),
    'the wider pull would write completed work orders into the open table');
  assert.ok(!/=== 'completed'/.test(body), 'the sync grew its own idea of closed');
});
t('what was dropped is reported, not silently discarded', () => {
  const i = code.indexOf("app.post('/api/maintenance/sync'");
  const body = code.slice(i, i + 3000);
  assert.ok(/droppedAsClosed/.test(body), 'a sync that drops 1000 rows looks like one that drops none');
  assert.ok(/openByStatus/.test(body), 'the response does not say what it wrote');
});

console.log("\nthe reconciliation's feed uses the same syntax");
t('wo_all carries the date range too', () => {
  // reconcileWorkOrders reads this store as "what AppFolio has open" and marks
  // anything absent from it Unknown. Left on params:{} it keeps the ~96-day
  // window, so the nine old work orders the documented syntax just recovered
  // would be marked Unknown and taken straight back off Erick's board.
  const reports = fs.readFileSync(path.join(__dirname, '..', 'appfolio-reports.js'), 'utf8');
  const i = reports.indexOf("id: 'wo_all'");
  assert.ok(i > 0, 'wo_all is gone');
  const body = reports.slice(i, i + 700);
  assert.ok(/status_date: '0'/.test(body), 'wo_all still pulls without a date range');
  assert.ok(!/params: \{\},/.test(body), 'wo_all is still the windowed pull');
});
t('wo_all resolves its end date per call', () => {
  const reports = fs.readFileSync(path.join(__dirname, '..', 'appfolio-reports.js'), 'utf8');
  const i = reports.indexOf("id: 'wo_all'");
  const body = reports.slice(i, i + 700);
  assert.ok(/params: \(\) => \(\{/.test(body), 'the end date freezes at deploy time');
  assert.ok(/status_date_range_to: new Date\(\)/.test(body));
});
t('the two feeds ask for the same statuses', () => {
  // A reconciliation whose idea of "open" is narrower than the sync's would
  // mark the difference Unknown on every run.
  const reports = fs.readFileSync(path.join(__dirname, '..', 'appfolio-reports.js'), 'utf8');
  const i = reports.indexOf("id: 'wo_all'");
  const body = reports.slice(i, i + 700);
  assert.ok(/\['0', '1', '2', '9', '11', '3', '6', '8', '12'\]/.test(body),
    "wo_all's status codes have drifted from the sync's");
});

console.log('\nthe dry run');
t('it writes nothing', () => {
  const i = code.indexOf('if (dryRun) {');
  const end = code.indexOf('const db = supabaseAdmin || supabasePublic;', i);
  assert.ok(i > 0 && end > i, 'there is no dry run branch');
  const body = code.slice(i, end);
  assert.ok(!/\.upsert\(|\.insert\(|\.update\(|\.delete\(/.test(body), 'the dry run writes');
  assert.ok(/wrote: 0/.test(body));
  assert.ok(body.indexOf('return res.json') > 0, 'the dry run falls through into the write');
});
t('it reports the difference against the old filter, by status', () => {
  const i = code.indexOf('if (dryRun) {');
  const body = code.slice(i, i + 1600);
  assert.ok(/narrowFilterOpen/.test(body), 'nothing says what the old filter saw');
  assert.ok(/addedByStatus/.test(body), '"18 more" cannot be read as specific statuses');
  assert.ok(/addedExamples/.test(body), 'no work order numbers to check by hand');
});
t('it is off unless asked for', () => {
  assert.ok(/const dryRun = !!\(req\.body && req\.body\.dryRun === true\);/.test(code),
    'the daily cron could silently become a dry run, or vice versa');
});
t('the 6 AM cron does NOT reconcile', () => {
  // Worth pinning. The reconciliation marks anything outside its two feeds
  // Unknown; running it nightly against a narrower feed than the sweep would
  // undo the 13 work orders the sweep reopened, every morning, silently.
  const i = code.indexOf("cron.schedule('0 6 * * *'");
  const body = code.slice(i, i + 400);
  assert.ok(/callOwnRoute\('\/api\/maintenance\/sync', \{\}\)/.test(body));
  assert.ok(!/reconcile/i.test(body), 'the nightly cron reconciles');
  assert.ok(!/dryRun/.test(body), 'the nightly cron would write nothing');
});

console.log('\nawaiting billing on the Command Center');
const cc = fs.readFileSync(path.join(__dirname, '..', 'public', 'command-center.js'), 'utf8');
const ccCode = cc.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
t('the browser loads the shared rule', () => {
  assert.ok(/src="\/lib\/work-order-status\.js"/.test(html),
    'the Command Center would have to invent its own definition again');
});
t('it is a separate line from the open work', () => {
  assert.ok(/ccAwaiting/.test(ccCode), 'nothing separates them');
  assert.ok(/WOS\.isAwaitingBilling\(woStatus\(r\)\)/.test(ccCode),
    'the Command Center tests the status itself instead of using the shared rule');
});
t('it says they are finished, and where they belong', () => {
  const i = ccCode.indexOf('ccAwaiting');
  const body = ccCode.slice(i, i + 900);
  assert.ok(/awaiting billing/i.test(body));
  assert.ok(/Billable Labor Report/.test(body), 'Erick is told what they are but not what to do');
  assert.ok(/Not field work/.test(body), 'nothing says these are not site visits');
});
t('they are still counted as open everywhere else', () => {
  // The separation is presentational. If it changed isOpen, the work orders
  // would vanish from the totals and the money would stop being chased.
  assert.strictEqual(WOS.isOpen('Ready to Bill'), true);
  assert.strictEqual(WOS.isOpen('Work Done'), true);
});

console.log(`\n${pass} passing`);
