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

console.log('the sync asks for every status and decides locally');
t('the status list is generated, not hand-picked', () => {
  const i = code.indexOf('const APPFOLIO_WORK_ORDER_FILTER');
  const body = code.slice(i, i + 400);
  assert.ok(/work_order_statuses: Array\.from\(\{ length: 31 \}/.test(body),
    'the filter still carries a hand-written code list');
  assert.ok(!/work_order_statuses: \['0', '1', '2', '9', '11', '3'\]/.test(body),
    'the six-code list is still the live filter');
});
t('the old narrow filter survives only for the dry run', () => {
  assert.ok(/APPFOLIO_WO_NARROW_FILTER/.test(code), 'there is nothing left to compare against');
  const uses = code.split('APPFOLIO_WO_NARROW_FILTER').length - 1;
  assert.ok(uses >= 2, 'the narrow filter is declared but never used');
  // It must not be what the sync pulls.
  assert.ok(!/appfolioReportsFetch\(APPFOLIO_WORK_ORDER_REPORT, APPFOLIO_WO_NARROW_FILTER\);\s*\n\s*const seen/.test(code),
    'the sync still pulls the narrow filter');
});
t('type and visibility filters are untouched', () => {
  // Widening the status list and dropping the type filter in one step would
  // make it impossible to say which change produced which rows.
  const i = code.indexOf('const APPFOLIO_WORK_ORDER_FILTER');
  const body = code.slice(i, i + 400);
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
