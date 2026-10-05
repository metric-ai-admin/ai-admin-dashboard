// Three things the 09/27–10/03 comparison against Katie's workbook exposed in
// lib/kpi-lyndsay.js. All three produced a number that looked computed.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const K = require('../lib/kpi-lyndsay.js');
const WOS = require('../lib/work-order-status.js');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };
const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'kpi-lyndsay.js'), 'utf8');
const code = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const W = '2026-09-27', E = '2026-10-03';
const wo = rows => K.workOrdersFrom(rows, W, E);
const P = 'Hyde Park Square';

console.log('openWos: one rule, shared with the rest of the dashboard');
t('the private exact-match WO_DONE is gone', () => {
  // It counted "Completed No Need To Bill" as OPEN. 258 such rows made openWos
  // read 179 against Katie's 92.
  assert.ok(!/WO_DONE\s*=/.test(code), 'the module still defines its own closed rule');
  assert.ok(/require\('\.\/work-order-status\.js'\)/.test(code), 'it does not use the shared module');
});
t('"Completed No Need To Bill" is not open', () => {
  const r = wo([{ property_name: P, status: 'Completed No Need To Bill' }]);
  assert.strictEqual(r[P].openWos, undefined, 'still counted as open');
});
t('Katie’s definition is reported separately from ours', () => {
  // Her filter excludes Work Done and Ready to Bill; ours keeps them because
  // they are money not yet billed. Both numbers are real and they are not the
  // same number.
  const r = wo([
    { property_name: P, status: 'Assigned' },
    { property_name: P, status: 'Ready to Bill' },
    { property_name: P, status: 'Work Done' },
  ]);
  assert.strictEqual(r[P].openWos, 3, 'all three are open');
  assert.strictEqual(r[P].openFieldWos, 1, 'her scope should be the one Assigned');
  assert.strictEqual(r[P].awaitingBilling, 2);
  assert.strictEqual(r[P].openFieldWos + r[P].awaitingBilling, r[P].openWos,
    'the split does not add up to open');
});
t('an Unknown row is neither open nor silently dropped', () => {
  const r = wo([{ property_name: P, status: WOS.UNKNOWN }]);
  assert.strictEqual(r[P].openWos, undefined, 'counted as open — overstates the work');
  assert.strictEqual(r[P].notInFeed, 1, 'it vanished from the counts entirely');
});

console.log('\nclosedThisWeek reads completed_on');
t('a work order closed in the week counts, whenever it was synced', () => {
  // This was keyed on updated_at. A work order closed on 09/30 and synced on
  // 10/05 landed in the wrong week, which is why the count read short on seven
  // of ten properties.
  const r = wo([{ property_name: P, status: 'Completed',
    completed_on: '2026-09-30', updated_at: '2026-10-05T12:00:00Z' }]);
  assert.strictEqual(r[P].closedThisWeek, 1, 'the sync date still decides the week');
});
t('one closed outside the week does not count', () => {
  const r = wo([{ property_name: P, status: 'Completed',
    completed_on: '2026-09-20', updated_at: '2026-09-30T12:00:00Z' }]);
  assert.strictEqual(r[P].closedThisWeek, undefined,
    'updated_at dragged a work order into a week it does not belong to');
});
t('a row with no completed_on still falls back to updated_at', () => {
  // Rows synced before migration 076 have no completed_on. Dropping them would
  // trade a slightly misplaced count for a silently missing one.
  const r = wo([{ property_name: P, status: 'Completed', updated_at: '2026-09-30T12:00:00Z' }]);
  assert.strictEqual(r[P].closedThisWeek, 1);
  assert.ok(/completed_on \|\| r\.updated_at/.test(code), 'the fallback is gone');
});
t('"Completed No Need To Bill" closes too', () => {
  const r = wo([{ property_name: P, status: 'Completed No Need To Bill', completed_on: '2026-09-30' }]);
  assert.strictEqual(r[P].closedThisWeek, 1, 'the spelling that started all of this is excluded again');
});

console.log('\ndqResidents counts somebody');
t('the delinquency store’s field is `name`', () => {
  // It read payer_name / tenant. Neither exists on delinquency_as_of, so the
  // count was 0 on every property in the 09/27 comparison while her report
  // showed 27 at Ascent alone.
  const r = K.dqFrom([
    { property_name: P, name: 'Mendoza, Simon', amount_receivable: '150.00' },
    { property_name: P, name: 'Garza, Ana', amount_receivable: '75.00' },
    { property_name: P, name: 'Mendoza, Simon', amount_receivable: '25.00' },
  ]);
  assert.strictEqual(r[P].dqResidents, 2, 'residents are counted per charge, or not at all');
  assert.strictEqual(r[P].dqTotal, 250);
});
t('payer_name still works for the Collections feed', () => {
  const r = K.dqFrom([{ property_name: P, payer_name: 'Ruiz, Pat', amount_receivable: '10.00' }]);
  assert.strictEqual(r[P].dqResidents, 1, 'the other feed lost its name field');
});
t('a zero or negative balance adds no resident', () => {
  // Concessions arrive as negatives. Counting their payer as delinquent would
  // report people who owe nothing.
  const r = K.dqFrom([{ property_name: P, name: 'Credit, A', amount_receivable: '-918.75' }]);
  assert.ok(!r[P] || !r[P].dqResidents, 'a credit counted as a delinquent resident');
});

console.log('\ndelinquency_as_of is refreshed on a schedule');
t('it has a cron', () => {
  // Its store was five days stale against a sheet explicitly "As of 10/03",
  // because nothing was scheduled to refresh it.
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const sc = server.split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  // Anchored FORWARD from the cron block. Searching for the first
  // syncReport('delinquency_as_of') finds decisionQueueData's on-demand
  // refresh, which has always been there and says nothing about a schedule —
  // the assertion passed on the wrong occurrence until this was pinned.
  const j = sc.indexOf("cron.schedule('45 17 * * *'");
  assert.ok(j > 0, 'the evening sync block moved');
  const block = sc.slice(j, sc.indexOf('cron.schedule(', j + 10));
  assert.ok(/syncReport\('delinquency_as_of'\)/.test(block),
    'nothing in the evening block refreshes it — the on-demand path is not a schedule');
  assert.ok(/}, 120000\);/.test(block),
    'it fires beside the other two pulls and races them into the rate limit');
});

console.log('\nleads: both readings, neither overwriting the other');
t('leads is Interest Received — Katie’s sheet filter', () => {
  const r = K.leadsFrom([
    { property: P, interest_received: '2026-09-28T10:00:00Z', first_contact_date: '2026-09-01' },
    { property: P, interest_received: '2026-09-01T10:00:00Z', first_contact_date: '2026-09-29' },
  ], W, E);
  assert.strictEqual(r[P].leads, 1, 'leads is not keyed on interest_received');
});
t('first contact is kept alongside it, not instead of it', () => {
  // The Goal Board and leasing_leads run on first_contact_date — Traffic, per
  // Lyndsay 2026-09-15. Replacing one with the other would move a number she
  // reads every Monday.
  const r = K.leadsFrom([
    { property: P, interest_received: '2026-09-01T10:00:00Z', first_contact_date: '2026-09-29' },
  ], W, E);
  assert.strictEqual(r[P].leadsByFirstContact, 1);
  assert.strictEqual(r[P].leads, undefined, 'the two readings have been collapsed into one');
});
t('both survive build()', () => {
  const o = K.build({ leads: [{ property: P, interest_received: '2026-09-28T10:00:00Z',
    first_contact_date: '2026-09-28' }] }, { weekStart: W, weekEnd: E, asOf: E });
  assert.strictEqual(o.byProperty[P].leads, 1);
  assert.strictEqual(o.byProperty[P].leadsByFirstContact, 1, 'dropped by METRICS again');
});

console.log('\nclosedThisWeek is scoped the way her sheet is');
t('Unit Turn work orders are excluded', () => {
  // Her "Work Orders Completed Last Week" is filtered to Work Order Type:
  // Resident and Internal. Keeping them made us count 19 at The Highlander
  // against her 9.
  const r = wo([
    { property_name: P, status: 'Completed', completed_on: '2026-09-30', work_order_type: 'Internal' },
    { property_name: P, status: 'Completed', completed_on: '2026-09-30', work_order_type: 'Unit Turn' },
    { property_name: P, status: 'Completed', completed_on: '2026-09-30', work_order_type: 'unit turn' },
  ]);
  assert.strictEqual(r[P].closedThisWeek, 1, 'Unit Turn still counted');
});
t('openFieldWos excludes Unit Turn too — her open sheet does', () => {
  const r = wo([
    { property_name: P, status: 'Assigned', work_order_type: 'Resident' },
    { property_name: P, status: 'Assigned', work_order_type: 'Unit Turn' },
  ]);
  assert.strictEqual(r[P].openFieldWos, 1, 'her scope includes Unit Turn');
  assert.strictEqual(r[P].openWos, 2, 'ours should still count every open work order');
  assert.strictEqual(r[P].openUnitTurn, 1, 'the excluded ones are not reported anywhere');
});
t('excluding them from her scope does not hide them from ours', () => {
  // The Unit Turn work orders are real work. They come out of HER comparison
  // metric, not out of the dashboard.
  const r = wo([{ property_name: P, status: 'Assigned', work_order_type: 'Unit Turn' }]);
  assert.strictEqual(r[P].openWos, 1);
  assert.strictEqual(r[P].openFieldWos, undefined);
});

console.log('\nthe Evict probe does not touch Collections');
t('it is read-only and leaves the registered report alone', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const i = server.indexOf("app.post('/api/collections/probe-tenant-statuses'");
  assert.ok(i > 0, 'the probe is gone');
  const body = server.slice(i, server.indexOf("app.post('/api/maintenance/probe-wo-window'"));
  assert.ok(!/\.upsert\(|\.insert\(|\.update\(|\.delete\(|syncReport\(/.test(body), 'the probe writes');
  assert.ok(/tenant_statuses: \[String\(code\)\]/.test(body), 'it does not ask per code');
  const reports = fs.readFileSync(path.join(__dirname, '..', 'appfolio-reports.js'), 'utf8');
  assert.ok(/tenant_statuses: \['0', '4'\]/.test(reports),
    'the Collections report’s own filter was changed — it was explicitly to be left alone');
});

console.log('\nevery metric workOrdersFrom computes survives build()');
t('the split reaches byProperty instead of being dropped', () => {
  // build() copies ONLY the names in METRICS. A metric computed upstream and
  // missing from that list is calculated and thrown away, which reads in a
  // comparison as "she reports it and we produce nothing" — which is exactly
  // how it showed up on the first pass of this change.
  const out = K.build({ workOrders: [
    { property_name: P, status: 'Assigned' },
    { property_name: P, status: 'Ready to Bill' },
    { property_name: P, status: WOS.UNKNOWN },
  ] }, { weekStart: W, weekEnd: E, asOf: E });
  const row = out.byProperty[P];
  assert.strictEqual(row.openFieldWos, 1, 'openFieldWos never reaches the output');
  assert.strictEqual(row.awaitingBilling, 1, 'awaitingBilling never reaches the output');
  assert.strictEqual(row.notInFeed, 1, 'notInFeed never reaches the output');
});
t('no metric workOrdersFrom produces is missing from METRICS', () => {
  // The general form, so the next metric added upstream cannot be dropped in
  // silence the way these three were.
  const produced = Object.keys(K.workOrdersFrom([
    { property_name: P, status: 'Assigned', created_at_appfolio: '2026-09-28' },
    { property_name: P, status: 'Ready to Bill' },
    { property_name: P, status: WOS.UNKNOWN },
    { property_name: P, status: 'Completed', completed_on: '2026-09-30' },
  ], W, E)[P]);
  const missing = produced.filter(k => K.METRICS.indexOf(k) === -1);
  assert.deepStrictEqual(missing, [], 'computed and then dropped by build(): ' + missing.join(', '));
});

console.log(`\n${pass} passing`);
